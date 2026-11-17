// Pi bridge: implements the core AgentBackend port with Pi's SDK.
// Knows Pi (ModelRuntime, AgentSession); knows nothing about ACP.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SettingsManager,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Logger, silentLogger } from "../core/log.ts";
import type { AgentBackend, BackendSession, PermissionAsk, TurnSink } from "../core/ports.ts";
import type { HistoryItem, McpServerSpec, ModelChoice, ModelGroup, ModelRef, PromptInput, ProviderBinding, ProviderSlotState, SessionSummary, TurnResult } from "../core/types.ts";
import { bridgeProviderId, DEFAULT_MODEL, joinBaseUrl, SLOTS, type SlotDefinition } from "./catalog.ts";
import { openPiTranscript, type SessionMeta, SessionStore } from "./session-store.ts";
import { BRIDGE_TOOLS, READ_ONLY_TOOLS, ToolTracker, toolKind, toolLocations, toolResultText, toolTitle } from "./tools.ts";
import { discoverModels, type ListedModel, listingIdMatches } from "./discovery.ts";

const IDE_NOTE =
	"You are running inside a JetBrains IDE (AIR) through the Agent Client Protocol. The user sees your Markdown answers and your tool calls in the IDE; edits and commands need their approval.";

export interface PiBackendOptions {
	/** Directory for Pi state of this bridge (isolated from the user's ~/.pi/agent). */
	stateDir?: string;
	version?: string;
	logger?: Logger;
	/** HTTP client for model discovery (defaults to global fetch). */
	fetch?: typeof fetch;
	discoveryTimeoutMs?: number;
	/** Trust the session's project for Pi project resources (skills). Default true. */
	trustProject?: boolean;
}

export class PiBackend implements AgentBackend {
	private readonly runtime: ModelRuntime;
	private readonly bindings = new Map<string, { binding: ProviderBinding; generation: number; status: "discovering" | "ready" | "failed" }>();
	private readonly pending = new Set<Promise<void>>();
	private readonly fetchImpl?: typeof fetch;
	private readonly discoveryTimeoutMs?: number;
	private generation = 0;
	readonly store: SessionStore;
	private readonly agentDir: string;
	private readonly trustProject: boolean;
	private readonly listeners = new Set<() => void>();
	readonly log: Logger;
	private readonly version: string;
	private counter = 0;

	private constructor(runtime: ModelRuntime, stateDir: string, options: PiBackendOptions) {
		this.runtime = runtime;
		this.store = new SessionStore(stateDir);
		this.agentDir = join(stateDir, "agent");
		this.log = options.logger ?? silentLogger;
		this.version = options.version ?? "0.0.0";
		this.fetchImpl = options.fetch;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs;
		this.trustProject = options.trustProject ?? true;
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
		// Policy: outside an account catalog, only the models Junie's picker offers (what AIR's infrastructure backs).
		let notInPicker: string[] = [];
		if (result.source !== "account") {
			const inPicker = (l: ListedModel) => slot.picker.findIndex((p) => listingIdMatches(l.id, p.id));
			notInPicker = listed.filter((l) => inPicker(l) < 0).map((l) => l.id);
			listed = listed
				.filter((l) => inPicker(l) >= 0)
				.sort((a, b) => inPicker(a) - inPicker(b))
				.map((l) => ({ ...l, displayName: slot.picker[inPicker(l)].name }));
		}
		const unknown: ListedModel[] = [];
		const matched: { listed: ListedModel; known: Model<Api> }[] = [];
		for (const l of listed) {
			const known = catalog.find((k) => listingIdMatches(l.id, k.id));
			if (known) matched.push({ listed: l, known });
			else unknown.push(l);
		}

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
				`${result.source === "account" && binding.selectedModels ? ` selected=${listed.length}` : ""}${notInPicker.length ? ` notInPicker=${notInPicker.length}` : ""} offered=${models.length} [${models.map((m) => m.id).join(", ")}]` +
				` piApi=${target.piApi} requestBase=${baseUrl}`,
		);
		if (notInPicker.length) this.log.debug(`discovery ${slot.id}: listed but not in the picker policy: [${notInPicker.join(", ")}]`);
		// Grep-able backlog: models the policy allows and the proxy serves, but Pi cannot describe yet (dropped).
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

	async openSession({ cwd, mcpServers = [] }: { cwd: string; mcpServers?: McpServerSpec[] }): Promise<BackendSession> {
		const id = `pi-${Date.now().toString(36)}-${++this.counter}`;
		const now = new Date().toISOString();
		const meta: SessionMeta = { id, cwd, createdAt: now, updatedAt: now };
		this.store.save(meta);
		this.log.info(`session ${id} opened (cwd ${cwd}), default model ${fmt(this.defaultModel())}`);
		return new PiSession(meta, this, mcpServers);
	}

	async resumeSession({
		sessionId,
		cwd,
		mcpServers = [],
	}: { sessionId: string; cwd: string; mcpServers?: McpServerSpec[] }): Promise<{ session: BackendSession; restored: boolean } | undefined> {
		if (!SessionStore.isValidId(sessionId)) {
			this.log.error(`session ${sessionId}: resume rejected, invalid id`);
			return undefined;
		}
		const meta = this.store.load(sessionId);
		if (!meta) {
			const now = new Date().toISOString();
			const fresh: SessionMeta = { id: sessionId, cwd, createdAt: now, updatedAt: now };
			this.store.save(fresh);
			this.log.warn(`session ${sessionId}: nothing saved under this id (created by an older build or deleted); continuing as an empty session`);
			return { session: new PiSession(fresh, this, mcpServers), restored: false };
		}
		if (meta.cwd !== cwd) this.log.info(`session ${sessionId}: resumed with cwd ${cwd} (saved ${meta.cwd})`);
		this.log.info(`session ${sessionId} resumed (saved model ${fmt(meta.model)}, created ${meta.createdAt})`);
		return { session: new PiSession({ ...meta, cwd }, this, mcpServers), restored: true };
	}

	listSessions({ cwd, limit }: { cwd?: string; limit: number }): SessionSummary[] {
		return this.store
			.list()
			.filter((m) => !cwd || m.cwd === cwd)
			.filter((m) => m.lastPromptAt) // never-prompted chats are not history
			.slice(0, limit)
			.map((m) => ({ id: m.id, cwd: m.cwd, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, lastPromptAt: m.lastPromptAt }));
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

	/**
	 * A Pi coding session: Pi's default system prompt and built-in tools, the project's context files
	 * (AGENTS.md/CLAUDE.md up the tree) and skills. No extensions, prompt templates or user Pi settings
	 * (isolated agentDir). `gate` is an inline Pi extension that decides on every tool call.
	 */
	async createPiSession(
		id: string,
		cwd: string,
		model: Model<Api>,
		thinkingLevel: ThinkingLevel,
		gate: (pi: ExtensionAPI) => void,
		mcpServers: McpServerSpec[],
	): Promise<AgentSession> {
		const { manager, restored } = this.store.piSessionManager(id, cwd);
		this.log.info(`session ${id}: Pi transcript ${restored ? `restored (${manager.getEntries().length} entries)` : "created"} at ${manager.getSessionFile() ?? "<memory>"}`);
		// The project the IDE opened is trusted for skills (project extensions stay off; edits/commands still ask).
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: this.trustProject });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			appendSystemPrompt: [IDE_NOTE],
			// The client's MCP servers (e.g. the IDE's own) are registered for this session and connected by Pi's MCP extension.
			extensionFactories: [gate, registerClientMcpServers(mcpServers), createMcpExtension()],
		});
		await resourceLoader.reload();
		const contextFiles = resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.path);
		const skills = resourceLoader.getSkills().skills.map((s) => s.name);
		this.log.info(
			`session ${id}: context files [${contextFiles.join(", ")}] skills [${skills.join(", ")}] projectTrusted=${this.trustProject}`,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.agentDir,
			model,
			thinkingLevel,
			modelRuntime: this.runtime,
			resourceLoader,
			tools: [...BRIDGE_TOOLS, "mcp__*"],
			sessionManager: manager,
			settingsManager,
		});
		// Emits session_start: Pi's MCP extension starts connecting the servers (prompts wait for direct tools).
		await session.bindExtensions({});
		if (mcpServers.length) this.log.info(`session ${id}: MCP servers registered [${mcpServers.map((s) => s.name).join(", ")}]`);
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
	/** Permission callback of the running turn (the Pi gate extension lives as long as the Pi session). */
	private ask?: PermissionAsk;
	/** Reports an allowed tool as running (set for the duration of a turn). */
	private onApproved?: (toolCallId: string, toolName: string) => void;
	private readonly alwaysAllowed = new Set<string>();
	/** Cost of this chat since it was opened in this agent process. */
	private costUsd = 0;

	private readonly mcpServers: McpServerSpec[];

	constructor(meta: SessionMeta, backend: PiBackend, mcpServers: McpServerSpec[] = []) {
		this.mcpServers = mcpServers;
		this.meta = meta;
		this.id = meta.id;
		this.cwd = meta.cwd;
		this.model = meta.model;
		this.backend = backend;
	}

	private persist(): void {
		this.backend.store.save({ ...this.meta, cwd: this.cwd, model: this.model });
	}

	effortLevels(): string[] {
		const model = this.backend.resolveModel(this.currentModel());
		if (!model) return [];
		return getSupportedThinkingLevels(model).filter((l) => l !== "off");
	}

	/** Selected level clamped to the current model; Junie's default (medium) when nothing was chosen. */
	currentEffort(): string | undefined {
		const levels = this.effortLevels();
		if (levels.length === 0) return undefined;
		const wanted = this.meta.effort ?? DEFAULT_EFFORT;
		if (levels.includes(wanted)) return wanted;
		const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
		return levels.find((l) => order.indexOf(l) >= order.indexOf(wanted)) ?? levels[levels.length - 1];
	}

	async selectEffort(level: string): Promise<void> {
		this.backend.log.info(`session ${this.id}: effort ${this.meta.effort ?? "default"} -> ${level}`);
		this.meta.effort = level;
		this.persist();
		this.pi?.setThinkingLevel(this.thinkingLevel());
	}

	private thinkingLevel(): ThinkingLevel {
		return (this.currentEffort() ?? "off") as ThinkingLevel;
	}

	title(): string | undefined {
		return this.meta.title;
	}

	history(): HistoryItem[] {
		const manager = this.pi?.sessionManager ?? openPiTranscript(this.backend.store, this.id, this.cwd);
		if (!manager) return [];
		const items: HistoryItem[] = [];
		const toolItems = new Map<string, Extract<HistoryItem, { kind: "tool" }>>();
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role: string; content: unknown; toolCallId?: string; isError?: boolean };
			if (message.role === "user") {
				const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as { type: string; text?: string }[]);
				const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
				items.push({ kind: "user", text, imageCount: parts.filter((p) => p.type === "image").length });
			} else if (message.role === "assistant") {
				for (const part of message.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[]) {
					if (part.type === "thinking" && part.thinking) items.push({ kind: "thought", text: part.thinking });
					else if (part.type === "text" && part.text) items.push({ kind: "assistant", text: part.text });
					else if (part.type === "toolCall" && part.id && part.name) {
						const item: Extract<HistoryItem, { kind: "tool" }> = {
							kind: "tool",
							update: {
								id: part.id,
								name: part.name,
								title: toolTitle(part.name, part.arguments),
								toolKind: toolKind(part.name),
								status: "pending", // completed by its toolResult below; stays pending if the turn was cut off
								input: part.arguments,
								locations: toolLocations(part.arguments, this.cwd),
							},
						};
						toolItems.set(part.id, item);
						items.push(item);
					}
				}
			} else if (message.role === "toolResult" && message.toolCallId) {
				const item = toolItems.get(message.toolCallId);
				if (!item) continue;
				item.update.status = message.isError ? "failed" : "completed";
				item.update.output = truncate(toolResultText({ content: message.content }), HISTORY_OUTPUT_MAX);
			}
		}
		return items;
	}

	/** The first prompt names the chat (like pi-acp's fallback title); sent once, then kept with the session. */
	private nameIfUntitled(text: string, sink: TurnSink): void {
		if (this.meta.title) return;
		const title = titleFromPrompt(text);
		if (!title) return;
		this.meta.title = title;
		this.persist();
		this.backend.log.info(`session ${this.id}: title "${title}"`);
		sink({ kind: "title", title });
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

	/** Pi extension: read-only tools run; everything else asks the user unless allowed for this chat. */
	/** Tool metadata from the Pi session (set when the gate extension loads). */
	private toolInfo?: (name: string) => { annotations?: { readOnlyHint?: boolean } } | undefined;

	/** Runs without asking: built-in read-only tools, MCP tools the server marks read-only, tools allowed for this chat. */
	private runsWithoutAsking(toolName: string): boolean {
		return READ_ONLY_TOOLS.has(toolName) || this.alwaysAllowed.has(toolName) || this.toolInfo?.(toolName)?.annotations?.readOnlyHint === true;
	}

	private readonly gate = (pi: ExtensionAPI) => {
		this.toolInfo = (name) => pi.getAllTools().find((t) => t.name === name);
		pi.on("tool_call", async (event) => {
			const log = this.backend.log;
			if (this.runsWithoutAsking(event.toolName)) return undefined;
			if (!this.ask) return { block: true, reason: "No client to ask for permission." };
			const decision = await this.ask({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				title: toolTitle(event.toolName, event.input),
				toolKind: toolKind(event.toolName),
				input: event.input,
				locations: toolLocations(event.input, this.cwd),
			}).catch((err: unknown) => {
				log.error(`session ${this.id}: permission request failed: ${(err as Error)?.message ?? String(err)}`);
				return "reject" as const;
			});
			log.info(`session ${this.id}: permission ${event.toolName} ${event.toolCallId} -> ${decision}`);
			if (decision === "allow_always") this.alwaysAllowed.add(event.toolName);
			if (decision === "reject") return { block: true, reason: "The user rejected this tool call." };
			this.onApproved?.(event.toolCallId, event.toolName);
			return undefined;
		});
	};

	async prompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk): Promise<TurnResult> {
		let { text } = input;
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
		if (!this.pi) this.pi = await this.backend.createPiSession(this.id, this.cwd, model, this.thinkingLevel(), this.gate, this.mcpServers);
		else if (this.pi.model?.id !== model.id || this.pi.model?.provider !== model.provider) await this.pi.setModel(model);
		if (this.pi.thinkingLevel !== this.thinkingLevel()) this.pi.setThinkingLevel(this.thinkingLevel());
		const pi = this.pi;
		this.nameIfUntitled(text || (input.images.length ? "Image" : ""), sink);
		this.meta.lastPromptAt = new Date().toISOString();
		this.persist();
		let images = input.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
		if (images.length && !model.input.includes("image")) {
			log.warn(`session ${this.id}: ${fmt(ref)} does not accept images; ${images.length} image(s) dropped`);
			text = `${text}\n\n[${images.length} image(s) omitted: ${model.name} does not accept images]`.trim();
			images = [];
		}
		const started = Date.now();
		log.info(`session ${this.id}: prompt start model=${fmt(ref)} effort=${pi.thinkingLevel} api=${model.api} baseUrl=${model.baseUrl} chars=${text.length} images=${images.length}`);

		let last: AssistantMessage | undefined;
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const tools = new ToolTracker(this.cwd);
		const tool = (update: ReturnType<ToolTracker["finished"]> | undefined) => update && sink({ kind: "tool", update });
		this.ask = ask;
		this.onApproved = (id, name) => tool(tools.approved(id, name));
		const unsubscribe = pi.subscribe((event) => {
			if (event.type === "message_update") {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta") sink({ kind: "text", delta: e.delta });
				else if (e.type === "thinking_delta") sink({ kind: "thought", delta: e.delta });
				else if (e.type === "toolcall_end") tool(tools.requested(e.toolCall.id, e.toolCall.name, e.toolCall.arguments));
			} else if (event.type === "tool_execution_start") {
				log.info(`session ${this.id}: tool ${event.toolName} ${event.toolCallId} start ${JSON.stringify(event.args).slice(0, 200)}`);
				const needsApproval = !this.runsWithoutAsking(event.toolName);
			tool(tools.started(event.toolCallId, event.toolName, event.args, needsApproval));
			} else if (event.type === "tool_execution_update") {
				tool(tools.progressed(event.toolCallId, event.toolName, event.partialResult));
			} else if (event.type === "tool_execution_end") {
				log.info(`session ${this.id}: tool ${event.toolName} ${event.toolCallId} ${event.isError ? "FAILED" : "done"}${event.durationMs !== undefined ? ` ${event.durationMs}ms` : ""}`);
				tool(tools.finished(event.toolCallId, event.toolName, event.result, event.isError));
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				last = event.message as AssistantMessage;
				const u = last.usage;
				total.input += u.input;
				total.output += u.output;
				total.cacheRead += u.cacheRead;
				total.cacheWrite += u.cacheWrite;
				total.cost += u.cost.total;
				this.costUsd += u.cost.total;
				sink({
					kind: "usage",
					inputTokens: u.input,
					outputTokens: u.output,
					contextUsed: u.input + u.cacheRead + u.cacheWrite + u.output,
					contextSize: model.contextWindow,
					costUsd: this.costUsd, // cumulative for the chat, like Junie's usage_update
				});
			}
		});
		const onAbort = () => void pi.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await pi.prompt(text, { images, expandPromptTemplates: false });
		} catch (err) {
			log.error(`session ${this.id}: prompt threw after ${Date.now() - started}ms: ${(err as Error).stack ?? String(err)}`);
			return { stop: signal.aborted ? "cancelled" : "error", error: (err as Error).message };
		} finally {
			unsubscribe();
			this.ask = undefined;
			this.onApproved = undefined;
			signal.removeEventListener("abort", onAbort);
		}
		const took = Date.now() - started;
		const tokens = last ? `in=${total.input} out=${total.output} cost=$${total.cost.toFixed(5)}` : "no assistant message";
		if (last?.stopReason === "error") log.error(`session ${this.id}: prompt failed after ${took}ms (${tokens}): ${last.errorMessage}`);
		else log.info(`session ${this.id}: prompt done after ${took}ms stop=${signal.aborted ? "cancelled" : last?.stopReason} ${tokens}`);
		if (signal.aborted || last?.stopReason === "aborted") return { stop: "cancelled" };
		const usage = last && { inputTokens: total.input, outputTokens: total.output, cachedReadTokens: total.cacheRead, cachedWriteTokens: total.cacheWrite };
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


function fmt(ref: ModelRef | undefined): string {
	return ref ? `${ref.slotId}/${ref.modelId}` : "none";
}

const DEFAULT_EFFORT = "medium";
/** Replayed tool output is cut to keep session/load small (the model still has the full transcript). */
const HISTORY_OUTPUT_MAX = 4000;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
const TITLE_MAX = 60;

export function titleFromPrompt(text: string): string | undefined {
	const line = text
		.split("\n")
		.map((l) => l.replace(/<context[^>]*>[\s\S]*$/, "").trim())
		.find((l) => l.length > 0);
	if (!line) return undefined;
	const clean = line.replace(/\s+/g, " ").replace(/^[#>*\-\s]+/, "");
	if (clean.length <= TITLE_MAX) return clean;
	const cut = clean.slice(0, TITLE_MAX);
	const space = cut.lastIndexOf(" ");
	return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Pi extension registering the client's MCP servers for one session, with tools exposed directly to the model. */
function registerClientMcpServers(servers: McpServerSpec[]) {
	return (pi: ExtensionAPI) => {
		for (const s of servers) {
			const name = s.name.replace(/[^A-Za-z0-9_-]/g, "_");
			if (s.transport === "stdio") pi.registerMcpServer(name, { command: s.command, args: s.args, env: s.env, exposure: "direct" });
			else pi.registerMcpServer(name, { type: "http", url: s.url, headers: s.headers, exposure: "direct" });
		}
	};
}
