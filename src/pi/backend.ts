// Pi bridge: implements the core AgentBackend port with Pi's SDK.
// Knows Pi (ModelRuntime, AgentSession); knows nothing about ACP.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Logger, silentLogger } from "../core/log.ts";
import type { AgentBackend, BackendSession, TurnSink } from "../core/ports.ts";
import type { ModelChoice, ModelGroup, ModelRef, ProviderBinding, ProviderSlotState, TurnResult } from "../core/types.ts";
import { bridgeProviderId, DEFAULT_MODEL, joinBaseUrl, SLOTS, type SlotDefinition } from "./catalog.ts";
import { type SessionMeta, SessionStore } from "./session-store.ts";
import { discoverModels, type ListedModel, listingIdMatches } from "./discovery.ts";

const SYSTEM_PROMPT = "You are Pi, a helpful assistant running inside a JetBrains IDE. Answer concisely. Use Markdown.";

export interface PiBackendOptions {
	/** Directory for Pi state of this bridge (isolated from the user's ~/.pi/agent). */
	stateDir?: string;
	version?: string;
	logger?: Logger;
	/** HTTP client for model discovery (defaults to global fetch). */
	fetch?: typeof fetch;
	discoveryTimeoutMs?: number;
}

export class PiBackend implements AgentBackend {
	private readonly runtime: ModelRuntime;
	private readonly bindings = new Map<string, { binding: ProviderBinding; generation: number; status: "discovering" | "ready" | "failed" }>();
	private readonly pending = new Set<Promise<void>>();
	private readonly fetchImpl?: typeof fetch;
	private readonly discoveryTimeoutMs?: number;
	private generation = 0;
	readonly store: SessionStore;
	private readonly listeners = new Set<() => void>();
	readonly log: Logger;
	private readonly version: string;
	private counter = 0;

	private constructor(runtime: ModelRuntime, stateDir: string, options: PiBackendOptions) {
		this.runtime = runtime;
		this.store = new SessionStore(stateDir);
		this.log = options.logger ?? silentLogger;
		this.version = options.version ?? "0.0.0";
		this.fetchImpl = options.fetch;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs;
	}

	static async create(options: PiBackendOptions = {}): Promise<PiBackend> {
		const stateDir = options.stateDir ?? join(homedir(), ".pi", "pi-junie");
		// Isolated credentials/models: the user's own Pi logins are never loaded, so they can't reach the proxy.
		const runtime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsPath: null, modelsStorePath: join(stateDir, "models-store.json") });
		return new PiBackend(runtime, stateDir, options);
	}

	identity() {
		return { name: "pi-junie", title: "Pi", version: `${this.version} (pi ${PI_VERSION})` };
	}

	providerSlots(): ProviderSlotState[] {
		return SLOTS.map((s) => ({
			id: s.id,
			displayName: s.displayName,
			supportedApiTypes: Object.keys(s.apiTypes),
			required: false,
			binding: this.bindings.get(s.id)?.binding,
		}));
	}

	bindProvider(binding: ProviderBinding): void {
		const slot = this.slot(binding.slotId);
		const target = slot.apiTypes[binding.apiType];
		if (!target) throw new Error(`slot ${slot.id} has no apiType ${binding.apiType}`);
		// A new binding invalidates the previous one's models until discovery answers (no fallback list).
		this.runtime.unregisterProvider(bridgeProviderId(slot.id));
		const generation = ++this.generation;
		this.bindings.set(slot.id, { binding, generation, status: "discovering" });
		this.log.info(
			`bind ${slot.id}: apiType=${binding.apiType} baseUrl=${binding.baseUrl} headers=[${Object.keys(binding.headers).join(", ")}]` +
				`${binding.selectedModels ? ` selectedModels=[${binding.selectedModels.join(", ")}]` : ""} -> discovering models`,
		);
		const done = this.discover(slot, binding, generation);
		this.pending.add(done);
		void done.finally(() => this.pending.delete(done));
		this.emit();
	}

	private async discover(slot: SlotDefinition, binding: ProviderBinding, generation: number): Promise<void> {
		const target = slot.apiTypes[binding.apiType];
		const started = Date.now();
		const result = await discoverModels(
			{ apiType: binding.apiType, baseUrl: binding.baseUrl, headers: binding.headers },
			{ fetch: this.fetchImpl, timeoutMs: this.discoveryTimeoutMs, log: this.log },
		);
		const state = this.bindings.get(slot.id);
		if (!state || state.generation !== generation) return; // superseded by a newer binding or unbound
		const took = Date.now() - started;
		if (result.kind === "failed") {
			state.status = "failed";
			this.log.error(`discovery ${slot.id}: FAILED after ${took}ms at ${result.url}: ${result.reason} -> no models for this provider`);
			this.emit();
			return;
		}

		const catalog = this.runtime.getModels().filter((m) => m.provider === target.catalogProvider);
		let listed = result.models;
		if (result.source === "account" && binding.selectedModels) {
			const byId = new Map(listed.map((m) => [m.id, m]));
			listed = binding.selectedModels.map((id) => byId.get(id)).filter((m): m is ListedModel => !!m);
		}
		const unknown: ListedModel[] = [];
		const matched: { listed: ListedModel; known: Model<Api> }[] = [];
		for (const l of listed) {
			const known = catalog.find((k) => listingIdMatches(l.id, k.id));
			if (known) matched.push({ listed: l, known });
			else unknown.push(l);
		}
		// Account catalogs carry the account's order; vendor listings are unordered, so use Pi's catalog order.
		if (result.source === "vendor") matched.sort((a, b) => catalog.indexOf(a.known) - catalog.indexOf(b.known));

		const models = matched.map(({ listed: l, known: m }) => ({
			id: l.id, // the proxy's id is what goes on the wire
			name: l.displayName ?? m.name,
			api: target.piApi,
			reasoning: m.reasoning,
			input: m.input,
			cost: {
				input: l.pricing?.input ?? m.cost.input,
				output: l.pricing?.output ?? m.cost.output,
				cacheRead: l.pricing?.cacheRead ?? m.cost.cacheRead,
				cacheWrite: l.pricing?.cacheWrite ?? m.cost.cacheWrite,
			},
			contextWindow: l.contextWindow ?? m.contextWindow,
			maxTokens: l.maxOutputTokens ?? m.maxTokens,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			...(m.compat ? { compat: m.compat } : {}),
		}));
		const baseUrl = joinBaseUrl(binding.baseUrl, target.basePath);
		if (models.length) {
			this.runtime.registerProvider(bridgeProviderId(slot.id), {
				name: `AIR ${slot.displayName}`,
				baseUrl,
				headers: binding.headers,
				apiKey: "air-proxy", // the proxy authenticates via headers; Pi just needs a non-empty key
				api: target.piApi,
				models,
			});
		}
		state.status = "ready";
		this.log.info(
			`discovery ${slot.id}: ${result.source} listing at ${result.url} after ${took}ms: listed=${result.models.length}` +
				`${result.source === "account" && binding.selectedModels ? ` selected=${listed.length}` : ""} offered=${models.length} [${models.map((m) => m.id).join(", ")}]` +
				` piApi=${target.piApi} requestBase=${baseUrl}`,
		);
		// Grep-able backlog of models the proxy allows but Pi cannot describe yet (dropped, like Junie does).
		for (const u of unknown) {
			this.log.warn(
				`[models-todo] ${slot.id}/${u.id} listed by the ${result.source} catalog but not in Pi's ${target.catalogProvider} catalog; not offered` +
					` (name=${u.displayName ?? "-"} context=${u.contextWindow ?? "-"} maxOut=${u.maxOutputTokens ?? "-"} input=${u.inputModalities?.join("+") ?? "-"})`,
			);
		}
		this.emit();
	}

	async modelsSettled(timeoutMs: number): Promise<void> {
		if (!this.pending.size) return;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<void>((r) => {
			timer = setTimeout(() => {
				this.log.warn(`model discovery still running after ${timeoutMs}ms; answering without it`);
				r();
			}, timeoutMs);
		});
		await Promise.race([Promise.allSettled([...this.pending]).then(() => undefined), timeout]);
		clearTimeout(timer);
	}

	unbindProvider(slotId: string): void {
		if (!this.bindings.delete(slotId)) {
			this.log.info(`unbind ${slotId}: was not bound`);
			return;
		}
		this.runtime.unregisterProvider(bridgeProviderId(slotId));
		this.log.info(`unbind ${slotId}: bound slots now [${[...this.bindings.keys()].join(", ")}]`);
		this.emit();
	}

	availableModels(): ModelGroup[] {
		return SLOTS.filter((s) => this.bindings.has(s.id)).map((s) => ({
			slotId: s.id,
			name: s.displayName,
			models: this.runtime
				.getModels()
				.filter((m) => m.provider === bridgeProviderId(s.id))
				.map((m): ModelChoice => ({ slotId: s.id, modelId: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning })),
		}));
	}

	onModelsChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	installedPlugins() {
		return []; // no Pi extensions are loaded into bridge sessions yet
	}

	async openSession({ cwd }: { cwd: string }): Promise<BackendSession> {
		const id = `pi-${Date.now().toString(36)}-${++this.counter}`;
		const now = new Date().toISOString();
		const meta: SessionMeta = { id, cwd, createdAt: now, updatedAt: now };
		this.store.save(meta);
		this.log.info(`session ${id} opened (cwd ${cwd}), default model ${fmt(this.defaultModel())}`);
		return new PiSession(meta, this);
	}

	async resumeSession({ sessionId, cwd }: { sessionId: string; cwd: string }): Promise<BackendSession | undefined> {
		const meta = this.store.load(sessionId);
		if (!meta) {
			this.log.warn(`session ${sessionId}: resume requested but no saved session exists`);
			return undefined;
		}
		if (meta.cwd !== cwd) this.log.info(`session ${sessionId}: resumed with cwd ${cwd} (saved ${meta.cwd})`);
		this.log.info(`session ${sessionId} resumed (saved model ${fmt(meta.model)}, created ${meta.createdAt})`);
		return new PiSession({ ...meta, cwd }, this);
	}

	/** Resolves a ModelRef to the Pi model registered for its binding. */
	resolveModel(ref: ModelRef | undefined): Model<Api> | undefined {
		if (!ref) return undefined;
		return this.runtime.getModel(bridgeProviderId(ref.slotId), ref.modelId);
	}

	defaultModel(): ModelRef | undefined {
		if (this.resolveModel(DEFAULT_MODEL)) return DEFAULT_MODEL;
		const first = this.availableModels().find((g) => g.models.length)?.models[0];
		return first ? { slotId: first.slotId, modelId: first.modelId } : undefined;
	}

	async createPiSession(id: string, cwd: string, model: Model<Api>): Promise<AgentSession> {
		const { manager, restored } = this.store.piSessionManager(id, cwd);
		this.log.info(`session ${id}: Pi transcript ${restored ? `restored (${manager.getEntries().length} entries)` : "created"} at ${manager.getSessionFile() ?? "<memory>"}`);
		const { session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel: "off",
			modelRuntime: this.runtime,
			resourceLoader: minimalResources(),
			noTools: "all",
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		});
		return session;
	}

	private slot(id: string): SlotDefinition {
		const slot = SLOTS.find((s) => s.id === id);
		if (!slot) throw new Error(`unknown provider slot ${id}`);
		return slot;
	}

	private emit() {
		for (const l of this.listeners) l();
	}
}

class PiSession implements BackendSession {
	readonly id: string;
	readonly cwd: string;
	private readonly backend: PiBackend;
	private readonly meta: SessionMeta;
	private model?: ModelRef;
	private pi?: AgentSession;

	constructor(meta: SessionMeta, backend: PiBackend) {
		this.meta = meta;
		this.id = meta.id;
		this.cwd = meta.cwd;
		this.model = meta.model;
		this.backend = backend;
	}

	private persist(): void {
		this.backend.store.save({ ...this.meta, cwd: this.cwd, model: this.model });
	}

	/** The selected model if it is still reachable (its provider may have been switched off), else the default. */
	currentModel(): ModelRef | undefined {
		return this.backend.resolveModel(this.model) ? this.model : this.backend.defaultModel();
	}

	async selectModel(ref: ModelRef): Promise<void> {
		const model = this.backend.resolveModel(ref);
		if (!model) throw new Error(`model ${ref.slotId}/${ref.modelId} is not available`);
		this.backend.log.info(`session ${this.id}: model ${fmt(this.model)} -> ${fmt(ref)}`);
		this.model = ref;
		this.persist();
		await this.pi?.setModel(model);
	}

	async prompt(text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
		const log = this.backend.log;
		const ref = this.currentModel();
		const model = this.backend.resolveModel(ref);
		if (this.model && ref !== this.model) log.warn(`session ${this.id}: selected model ${fmt(this.model)} is no longer available, using ${fmt(ref)}`);
		if (!ref || !model) {
			log.error(`session ${this.id}: prompt rejected, no provider bound`);
			return { stop: "error", error: "No model available: the IDE has not configured any provider for Pi." };
		}
		if (this.model !== ref) {
			this.model = ref;
			this.persist();
		}
		if (!this.pi) this.pi = await this.backend.createPiSession(this.id, this.cwd, model);
		else if (this.pi.model?.id !== model.id || this.pi.model?.provider !== model.provider) await this.pi.setModel(model);
		const pi = this.pi;
		const started = Date.now();
		log.info(`session ${this.id}: prompt start model=${fmt(ref)} api=${model.api} baseUrl=${model.baseUrl} chars=${text.length}`);

		let last: AssistantMessage | undefined;
		const unsubscribe = pi.subscribe((event) => {
			if (event.type === "message_update") {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta") sink({ kind: "text", delta: e.delta });
				else if (e.type === "thinking_delta") sink({ kind: "thought", delta: e.delta });
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				last = event.message as AssistantMessage;
				const u = last.usage;
				sink({
					kind: "usage",
					inputTokens: u.input,
					outputTokens: u.output,
					contextUsed: u.input + u.cacheRead + u.cacheWrite + u.output,
					contextSize: model.contextWindow,
					costUsd: u.cost.total,
				});
			}
		});
		const onAbort = () => void pi.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await pi.prompt(text);
		} catch (err) {
			log.error(`session ${this.id}: prompt threw after ${Date.now() - started}ms: ${(err as Error).stack ?? String(err)}`);
			return { stop: signal.aborted ? "cancelled" : "error", error: (err as Error).message };
		} finally {
			unsubscribe();
			signal.removeEventListener("abort", onAbort);
		}
		const took = Date.now() - started;
		const tokens = last ? `in=${last.usage.input} out=${last.usage.output} cost=$${last.usage.cost.total.toFixed(5)}` : "no assistant message";
		if (last?.stopReason === "error") log.error(`session ${this.id}: prompt failed after ${took}ms (${tokens}): ${last.errorMessage}`);
		else log.info(`session ${this.id}: prompt done after ${took}ms stop=${signal.aborted ? "cancelled" : last?.stopReason} ${tokens}`);
		if (signal.aborted || last?.stopReason === "aborted") return { stop: "cancelled" };
		const usage = last && { inputTokens: last.usage.input, outputTokens: last.usage.output, cachedReadTokens: last.usage.cacheRead, cachedWriteTokens: last.usage.cacheWrite };
		if (last?.stopReason === "error") return { stop: "error", error: last.errorMessage ?? "model error", usage };
		if (last?.stopReason === "length") return { stop: "max_tokens", usage };
		return { stop: "end_turn", usage };
	}

	async close(): Promise<void> {
		this.backend.log.info(`session ${this.id} closed`);
		this.pi?.dispose();
		this.pi = undefined;
	}
}

function minimalResources(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => SYSTEM_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function fmt(ref: ModelRef | undefined): string {
	return ref ? `${ref.slotId}/${ref.modelId}` : "none";
}
