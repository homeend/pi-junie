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
import type { AgentBackend, BackendSession, TurnSink } from "../core/ports.ts";
import type { ModelChoice, ModelGroup, ModelRef, ProviderBinding, ProviderSlotState, TurnResult } from "../core/types.ts";
import { bridgeProviderId, DEFAULT_MODEL, SLOTS, type SlotDefinition } from "./catalog.ts";

const SYSTEM_PROMPT = "You are Pi, a helpful assistant running inside a JetBrains IDE. Answer concisely. Use Markdown.";

export interface PiBackendOptions {
	/** Directory for Pi state of this bridge (isolated from the user's ~/.pi/agent). */
	stateDir?: string;
	version?: string;
	log?: (line: string) => void;
}

export class PiBackend implements AgentBackend {
	private readonly runtime: ModelRuntime;
	private readonly bindings = new Map<string, ProviderBinding>();
	private readonly listeners = new Set<() => void>();
	private readonly log: (line: string) => void;
	private readonly version: string;
	private counter = 0;

	private constructor(runtime: ModelRuntime, options: PiBackendOptions) {
		this.runtime = runtime;
		this.log = options.log ?? (() => {});
		this.version = options.version ?? "0.0.0";
	}

	static async create(options: PiBackendOptions = {}): Promise<PiBackend> {
		const stateDir = options.stateDir ?? join(homedir(), ".pi", "pi-junie");
		// Isolated credentials/models: the user's own Pi logins are never loaded, so they can't reach the proxy.
		const runtime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsPath: null, modelsStorePath: join(stateDir, "models-store.json") });
		return new PiBackend(runtime, options);
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
			binding: this.bindings.get(s.id),
		}));
	}

	bindProvider(binding: ProviderBinding): void {
		const slot = this.slot(binding.slotId);
		const target = slot.apiTypes[binding.apiType];
		if (!target) throw new Error(`slot ${slot.id} has no apiType ${binding.apiType}`);
		const models = slot.models
			.map((id) => this.runtime.getModel(target.catalogProvider, id))
			.filter((m): m is Model<Api> => !!m)
			.map((m) => ({
				id: m.id,
				name: m.name,
				api: target.piApi,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
				...(m.compat ? { compat: m.compat } : {}),
			}));
		this.runtime.registerProvider(bridgeProviderId(slot.id), {
			name: `AIR ${slot.displayName}`,
			baseUrl: binding.baseUrl,
			headers: binding.headers,
			apiKey: "air-proxy", // the proxy authenticates via headers; Pi just needs a non-empty key
			api: target.piApi,
			models,
		});
		this.bindings.set(slot.id, binding);
		this.log(`bound ${slot.id} (${binding.apiType}) -> ${binding.baseUrl}: ${models.length} models`);
		this.emit();
	}

	unbindProvider(slotId: string): void {
		if (!this.bindings.delete(slotId)) return;
		this.runtime.unregisterProvider(bridgeProviderId(slotId));
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
		return new PiSession(`pi-${Date.now().toString(36)}-${++this.counter}`, cwd, this);
	}

	/** Resolves a ModelRef to the Pi model registered for its binding. */
	resolveModel(ref: ModelRef): Model<Api> | undefined {
		return this.runtime.getModel(bridgeProviderId(ref.slotId), ref.modelId);
	}

	defaultModel(): ModelRef | undefined {
		if (this.resolveModel(DEFAULT_MODEL)) return DEFAULT_MODEL;
		const first = this.availableModels().find((g) => g.models.length)?.models[0];
		return first ? { slotId: first.slotId, modelId: first.modelId } : undefined;
	}

	async createPiSession(cwd: string, model: Model<Api>): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd,
			model,
			thinkingLevel: "off",
			modelRuntime: this.runtime,
			resourceLoader: minimalResources(),
			noTools: "all",
			sessionManager: SessionManager.inMemory(cwd),
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
	private model?: ModelRef;
	private pi?: AgentSession;

	constructor(id: string, cwd: string, backend: PiBackend) {
		this.id = id;
		this.cwd = cwd;
		this.backend = backend;
	}

	currentModel(): ModelRef | undefined {
		return this.model ?? this.backend.defaultModel();
	}

	async selectModel(ref: ModelRef): Promise<void> {
		const model = this.backend.resolveModel(ref);
		if (!model) throw new Error(`model ${ref.slotId}/${ref.modelId} is not available`);
		this.model = ref;
		await this.pi?.setModel(model);
	}

	async prompt(text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
		const ref = this.model ?? this.backend.defaultModel();
		const model = ref && this.backend.resolveModel(ref);
		if (!ref || !model) return { stop: "error", error: "No model available: the IDE has not configured any provider for Pi." };
		this.model = ref;
		if (!this.pi) this.pi = await this.backend.createPiSession(this.cwd, model);
		else if (this.pi.model?.id !== model.id || this.pi.model?.provider !== model.provider) await this.pi.setModel(model);
		const pi = this.pi;

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
			return { stop: signal.aborted ? "cancelled" : "error", error: (err as Error).message };
		} finally {
			unsubscribe();
			signal.removeEventListener("abort", onAbort);
		}
		if (signal.aborted || last?.stopReason === "aborted") return { stop: "cancelled" };
		const usage = last && { inputTokens: last.usage.input, outputTokens: last.usage.output, cachedReadTokens: last.usage.cacheRead, cachedWriteTokens: last.usage.cacheWrite };
		if (last?.stopReason === "error") return { stop: "error", error: last.errorMessage ?? "model error", usage };
		if (last?.stopReason === "length") return { stop: "max_tokens", usage };
		return { stop: "end_turn", usage };
	}

	async close(): Promise<void> {
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
