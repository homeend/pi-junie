// Pi bridge: implements the core AgentBackend port with Pi's SDK.
// Knows Pi (ModelRuntime, AgentSession); knows nothing about ACP.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
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
import type { AgentBackend, BackendSession, PermissionAsk, QuestionAsk, SessionContext, TurnSink } from "../core/ports.ts";
import type { ApprovalMode, CommandInfo, HistoryItem, McpServerSpec, ModelChoice, ModelGroup, ModelRef, PromptInput, ProviderBinding, ProviderSlotState, SessionSummary, SteerResult, TurnResult } from "../core/types.ts";
import { bridgeProviderId, DEFAULT_MODEL, joinBaseUrl, SLOTS, type SlotDefinition, vertexBaseUrl } from "./catalog.ts";
import { openPiTranscript, type SessionMeta, SessionStore } from "./session-store.ts";
import { BRIDGE_TOOLS, READ_ONLY_TOOLS, toolKind, toolLocations, toolResultText, toolTitle } from "./tools.ts";
import { IDE_ROUTER_TOOL, IDE_SERVER, ideRouterName, ideServerToolExposure, JUNIE_COMPAT_DEFAULTS, type JunieCompatOptions, junieExecuteToolAlias } from "./junie-compat.ts";
import { classifyFailure } from "./failures.ts";
import { PLACEHOLDER_API_KEY } from "./proxy-auth.ts";
import { ASK_USER_TOOL, askUserTool } from "./ask-user.ts";
import { type PhaseSplitterOptions, signaturePhase } from "./phases.ts";
import { TranscriptStream } from "./transcript.ts";
import { isReadOnlyCommand } from "./safe-commands.ts";
import { AGENT_TOOL, installChildSessionHook, markBridgeSession, SubagentRelay, subagentModelsNote, withChildHost } from "./subagents.ts";
import { type DetectedPlugin, detectPlugins, pluginWelcomeLines, SUBAGENT_TOOLS, SUBAGENTS_PLUGIN } from "./plugins.ts";
import { discoverModels, type ListedModel, listingIdMatches } from "./discovery.ts";

function ideRouterNote(name: string): string {
	return `The IDE tool \`${name}\` runs IDE tools by name: \`command: "<tool> --param value ..."\`. Use it when the user asks you to do something in the IDE, or when a skill you read for the task directs you to. Take tool names from such skills, from the router's own description, or from its error messages (they say which parameter is missing). Do not cycle through guessed names: after one 'not found', tell the user which IDE capability seems to be missing.`;
}

const IDE_NOTE =
	"You are running inside a JetBrains IDE (AIR) through the Agent Client Protocol. The user sees your Markdown answers and your tool calls in the IDE; edits and commands may need their approval.\n" +
	"In the user's messages, `@name` mentions a file or folder (existing or to be created) by its path relative to the project: the `@` is not part of the name. `create @notes/a.txt` means the file `notes/a.txt`.";

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
	/** Junie compatibility profile (see junie-compat.ts). */
	junieCompat?: Partial<JunieCompatOptions>;
	/** How long the start of a message is held back to tell commentary from the answer (see phases.ts). */
	phaseHold?: PhaseSplitterOptions;
	/** The user's Pi agent dir, searched for plugins installed with `pi install` (see plugins.ts). Unset: no plugins. */
	piAgentDir?: string;
	/** Open new sessions with a welcome message (Pi version, plugin availability). Default false. */
	welcome?: boolean;
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
	private readonly junieCompat: JunieCompatOptions;
	private readonly listeners = new Set<() => void>();
	readonly log: Logger;
	private readonly version: string;
	private counter = 0;
	readonly phaseHold?: PhaseSplitterOptions;
	private readonly plugins: DetectedPlugin[];
	private readonly showWelcome: boolean;

	private constructor(runtime: ModelRuntime, stateDir: string, options: PiBackendOptions) {
		this.runtime = runtime;
		this.store = new SessionStore(stateDir);
		this.agentDir = join(stateDir, "agent");
		this.log = options.logger ?? silentLogger;
		this.version = options.version ?? "0.0.0";
		this.fetchImpl = options.fetch;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs;
		this.trustProject = options.trustProject ?? true;
		this.phaseHold = options.phaseHold;
		this.junieCompat = { ...JUNIE_COMPAT_DEFAULTS, ...options.junieCompat };
		this.plugins = options.piAgentDir ? detectPlugins(options.piAgentDir, this.log) : [];
		if (this.plugins.some((p) => p.name === SUBAGENTS_PLUGIN)) {
			installChildSessionHook();
			// The plugin saves its children as ordinary Pi sessions in Pi's default session dir (its `rememberAgents`),
			// where the IDE lists them as Pi chats. In this process they belong to the bridge: keep them in its state dir.
			// (Bridge sessions always pass their own dir, so only the plugin reads this.)
			process.env.PI_CODING_AGENT_SESSION_DIR = join(stateDir, "subagents");
			this.log.info(`subagent transcripts go to ${process.env.PI_CODING_AGENT_SESSION_DIR}`);
		}
		this.showWelcome = options.welcome ?? false;
		const subagents = this.plugins.some((p) => p.name === SUBAGENTS_PLUGIN);
		this.log.info(`subagents: ${subagents ? "available" : "not available"}`);
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
		const described: string[] = [];
		const matched: { listed: ListedModel; known: Model<Api> }[] = [];
		for (const l of listed) {
			let known = catalog.find((k) => listingIdMatches(l.id, k.id));
			if (!known) {
				const like = this.describedLike(l, slot, catalog);
				if (like) described.push(`${l.id} (like ${like.base})`);
				known = like?.model;
			}
			if (known) matched.push({ listed: l, known });
			else unknown.push(l);
		}
		if (described.length) {
			this.log.warn(`[models-todo] ${slot.id}: not in Pi's ${target.catalogProvider} catalog, described from Junie's definitions: ${described.join(", ")}`);
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
		const baseUrl = target.piApi === "google-vertex" ? vertexBaseUrl(binding.baseUrl, binding.vertex) : joinBaseUrl(binding.baseUrl, target.basePath);
		if (models.length) {
			this.runtime.registerProvider(bridgeProviderId(slot.id), {
				name: `AIR ${slot.displayName}`,
				baseUrl,
				headers: binding.headers,
				apiKey: PLACEHOLDER_API_KEY, // Pi needs a key; withoutPlaceholderAuth removes it from requests (see proxy-auth.ts)
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

	/** A picker model Pi does not know, described as the Pi model Junie says it matches (see PickerModel.like). */
	private describedLike(listed: ListedModel, slot: SlotDefinition, catalog: Model<Api>[]): { model: Model<Api>; base: string } | undefined {
		const entry = slot.picker.find((p) => p.like && listingIdMatches(listed.id, p.id));
		const base = entry?.like && catalog.find((k) => k.id === entry.like!.model);
		if (!entry?.like || !base) return undefined;
		return { model: { ...base, id: entry.id, name: entry.name, cost: { ...base.cost, ...entry.like.cost } }, base: base.id };
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

	welcome(): string | undefined {
		if (!this.showWelcome) return undefined;
		return [`**Pi** ${this.identity().version} is ready.`, "", ...pluginWelcomeLines(this.plugins)].join("\n");
	}

	installedPlugins() {
		return this.plugins.map(({ name, version }) => ({ name, version }));
	}

	async openSession(context: SessionContext): Promise<BackendSession> {
		const { cwd } = context;
		const id = `pi-${Date.now().toString(36)}-${++this.counter}`;
		const now = new Date().toISOString();
		const meta: SessionMeta = { id, cwd, createdAt: now, updatedAt: now };
		this.store.save(meta);
		this.log.info(`session ${id} opened (cwd ${cwd}), default model ${fmt(this.defaultModel())}`);
		return new PiSession(meta, this, context);
	}

	async resumeSession(context: SessionContext & { sessionId: string }): Promise<{ session: BackendSession; restored: boolean } | undefined> {
		const { sessionId, cwd } = context;
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
			return { session: new PiSession(fresh, this, context), restored: false };
		}
		if (meta.cwd !== cwd) this.log.info(`session ${sessionId}: resumed with cwd ${cwd} (saved ${meta.cwd})`);
		this.log.info(`session ${sessionId} resumed (saved model ${fmt(meta.model)}, created ${meta.createdAt})`);
		return { session: new PiSession({ ...meta, cwd }, this, context), restored: true };
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
	/**
	 * Pi resources for a session: context files, project + client skills, the IDE note. Shared by the Pi session
	 * and by the command list (which needs the skills before the first prompt).
	 */
	async resources(cwd: string, context: SessionContext, extensionFactories: ((pi: ExtensionAPI) => void)[] = []) {
		const hasIde = (context.mcpServers ?? []).some((s) => s.name === IDE_SERVER);
		// Client skill roots (AIR's IDE skills, e.g. ij-debugger) are read like Junie: <root>/.agents/skills and <root>/.junie/skills.
		const clientSkillPaths = (context.skillRoots ?? []).flatMap((r) => [join(r, ".agents", "skills"), join(r, ".junie", "skills")]).filter((p) => existsSync(p));
		// The project the IDE opened is trusted for skills (project extensions stay off; edits/commands still ask).
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: this.trustProject });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			additionalSkillPaths: clientSkillPaths,
			// Plugins the user installed with `pi install` (only known ones, see plugins.ts).
			additionalExtensionPaths: this.plugins.map((p) => p.path),
			// Plugin skills drive plugin tools the bridge leaves off (the subagents plugin's `workflow-authoring` is for
			// its SubagentWorkflow tool): not offered.
			skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => !this.plugins.some((p) => s.filePath.startsWith(`${p.path}/`))) }),
			appendSystemPrompt: [IDE_NOTE, ...(hasIde ? [ideRouterNote(ideRouterName(this.junieCompat))] : [])],
			extensionFactories,
		});
		await resourceLoader.reload();
		return { resourceLoader, settingsManager };
	}

	async createPiSession(
		id: string,
		cwd: string,
		model: Model<Api>,
		thinkingLevel: ThinkingLevel,
		gate: (pi: ExtensionAPI) => void,
		context: SessionContext,
		askUser?: (pi: ExtensionAPI) => void,
	): Promise<AgentSession> {
		const mcpServers = context.mcpServers ?? [];
		const hasIde = mcpServers.some((s) => s.name === IDE_SERVER);
		const routerAlias = hasIde && this.junieCompat.executeToolAlias;
		const { manager, restored } = this.store.piSessionManager(id, cwd);
		this.log.info(`session ${id}: Pi transcript ${restored ? `restored (${manager.getEntries().length} entries)` : "created"} at ${manager.getSessionFile() ?? "<memory>"}`);
		const { resourceLoader, settingsManager } = await this.resources(cwd, context, [
			gate,
			// The client's MCP servers (e.g. the IDE's own) are registered for this session and connected by Pi's MCP extension.
			registerClientMcpServers(mcpServers, this.junieCompat),
			createMcpExtension(),
			...(routerAlias ? [junieExecuteToolAlias] : []),
			...(askUser ? [askUser] : []),
			...(this.plugins.some((p) => p.name === SUBAGENTS_PLUGIN) ? [subagentModelsNote] : []),
		]);
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
			tools: [...BRIDGE_TOOLS, "mcp__*", ...(routerAlias ? [IDE_ROUTER_TOOL] : []), ...(askUser ? [ASK_USER_TOOL] : []), ...this.pluginTools()],
			sessionManager: manager,
			settingsManager,
		});
		markBridgeSession(session); // never adopted as a subagent of another session
		// Emits session_start: Pi's MCP extension starts connecting the servers (prompts wait for direct tools).
		await session.bindExtensions({});
		if (mcpServers.length) {
			this.log.info(`session ${id}: MCP servers registered [${mcpServers.map((s) => s.name).join(", ")}]${hasIde ? ` IDE router as ${ideRouterName(this.junieCompat)}` : ""}`);
		}
		return session;
	}

	/** Tools of the loaded plugins that bridge sessions enable. */
	private pluginTools(): string[] {
		return this.plugins.some((p) => p.name === SUBAGENTS_PLUGIN) ? SUBAGENT_TOOLS : [];
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
	/** Question form callback of the running turn (for ask_user). */
	private askUser?: QuestionAsk;
	/** Reports an allowed tool as running (set for the duration of a turn). */
	private onApproved?: (toolCallId: string, toolName: string) => void;
	private readonly alwaysAllowed = new Set<string>();
	/** Cost of this chat since it was opened in this agent process. */
	private costUsd = 0;
	/**
	 * Where the current turn is, for steering: "dispatching" (preparing, Pi not called yet), "running"
	 * (inside Pi's prompt, messages can be queued), "command" (a command like /compact, no messages).
	 */
	private phase: "idle" | "dispatching" | "running" | "command" = "idle";
	/** Settles when the turn leaves "dispatching". */
	private dispatched: Promise<void> = Promise.resolve();
	private endDispatch = () => {};
	/** Steered messages still being handed to Pi (Pi's steer() awaits before it queues). */
	private readonly steersInFlight = new Set<Promise<unknown>>();

	private readonly context: SessionContext;

	constructor(meta: SessionMeta, backend: PiBackend, context: SessionContext = { cwd: meta.cwd }) {
		this.context = context;
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

	approvalMode(): ApprovalMode {
		return this.meta.approvalMode ?? DEFAULT_APPROVAL_MODE;
	}

	async selectApprovalMode(mode: ApprovalMode): Promise<void> {
		this.backend.log.info(`session ${this.id}: brave mode ${this.approvalMode()} -> ${mode}`);
		this.meta.approvalMode = mode;
		this.persist();
	}

	private thinkingLevel(): ThinkingLevel {
		return (this.currentEffort() ?? "off") as ThinkingLevel;
	}

	title(): string | undefined {
		return this.meta.title;
	}

	private commandList?: Promise<CommandInfo[]>;

	commands(): Promise<CommandInfo[]> {
		this.commandList ??= this.backend.resources(this.cwd, this.context).then(({ resourceLoader }) => [
			{ name: "new", description: "Open a new empty chat", kind: "new_session" },
			{ name: "compact", description: "Summarize the conversation so far to free up context", hint: "optional instructions for the summary", kind: "builtin" },
			...resourceLoader.getSkills().skills.map(
				(sk): CommandInfo => ({ name: sk.name, description: sk.description, hint: "optional task for the skill", kind: "skill", skillPath: sk.filePath }),
			),
		]);
		return this.commandList;
	}

	/** `/compact [instructions]`: Pi's compaction of the current conversation. */
	private async compact(args: string, sink: TurnSink): Promise<TurnResult> {
		const log = this.backend.log;
		const pi = this.pi;
		if (!pi || pi.sessionManager.getEntries().length === 0) {
			sink({ kind: "text", delta: "Nothing to compact yet." });
			return { stop: "end_turn" };
		}
		try {
			const r = await pi.compact(args || undefined);
			log.info(`session ${this.id}: compacted ${r.tokensBefore} -> ${r.estimatedTokensAfter ?? "?"} tokens`);
			sink({ kind: "text", delta: `Compacted the conversation (${r.tokensBefore} tokens before${r.estimatedTokensAfter ? `, about ${r.estimatedTokensAfter} after` : ""}).` });
			return { stop: "end_turn" };
		} catch (err) {
			const message = (err as Error).message;
			// Pi keeps the recent turns; a short conversation has nothing older to summarize.
			if (/nothing to compact/i.test(message)) {
				sink({ kind: "text", delta: "Nothing to compact yet: the conversation is still short enough." });
				return { stop: "end_turn" };
			}
			log.error(`session ${this.id}: compaction failed: ${message}`);
			const failure = classifyFailure(message);
			return { stop: "error", error: `Compaction failed: ${message}`, failure: { ...failure, title: `Compaction failed: ${failure.title}` } };
		}
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
				const parts = message.content as { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; textSignature?: string }[];
				const callsTools = parts.some((p) => p.type === "toolCall");
				for (const part of parts) {
					if (part.type === "thinking" && part.thinking) items.push({ kind: "thought", text: part.thinking });
					else if (part.type === "text" && part.text) {
						const phase = signaturePhase(part.textSignature) ?? (callsTools ? "commentary" : "final_answer");
						items.push({ kind: "assistant", text: part.text, phase });
					}
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
	private allTools?: () => { name: string; description?: string; parameters?: unknown; annotations?: { readOnlyHint?: boolean } }[];

	private mcpToolsLogged = false;

	/** Logs what each connected MCP server offers (name, read-only flag, description, parameters), once per session. */
	private logMcpToolsOnce(): void {
		if (this.mcpToolsLogged || !this.allTools) return;
		const mcp = this.allTools().filter((t) => t.name.startsWith("mcp__"));
		if (!mcp.length) return;
		this.mcpToolsLogged = true;
		for (const t of mcp) {
			this.backend.log.info(
				`session ${this.id}: mcp tool ${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""} description=${JSON.stringify(t.description ?? "")} parameters=${JSON.stringify(t.parameters ?? {})}`,
			);
		}
	}

	/**
	 * Runs without asking: everything in Brave mode; read-only shell commands in Auto mode; otherwise built-in read-only
	 * tools, MCP tools the server marks read-only and tools allowed for this chat.
	 */
	private approvedUpfront(toolName: string, input: unknown): boolean {
		const mode = this.approvalMode();
		if (mode === "brave") return true;
		if (mode === "auto" && toolName === "bash" && isReadOnlyCommand(String((input as { command?: unknown } | undefined)?.command ?? ""))) return true;
		return this.runsWithoutAsking(toolName);
	}

	/** Runs without asking in every mode: built-in read-only tools, MCP tools the server marks read-only, tools allowed for this chat. */
	private runsWithoutAsking(toolName: string): boolean {
		// ask_user is itself a question to the user: no separate permission.
		// The subagent tools only start or steer children, whose own tools pass this gate.
		return READ_ONLY_TOOLS.has(toolName) || toolName === ASK_USER_TOOL || SUBAGENT_TOOLS.includes(toolName) || this.alwaysAllowed.has(toolName) || this.toolInfo?.(toolName)?.annotations?.readOnlyHint === true;
	}

	private readonly gate = (pi: ExtensionAPI) => {
		this.toolInfo = (name) => pi.getAllTools().find((t) => t.name === name);
		this.allTools = () => pi.getAllTools();
		pi.on("tool_call", async (event) => {
			// A call made by another tool (e.g. the execute_tool alias forwarding to the IDE router) was approved with its parent.
			if ((event as { parentToolCallId?: string }).parentToolCallId) return undefined;
			// Subagents run in the foreground for now: their child session lives within the parent's turn.
			if (event.toolName === AGENT_TOOL) (event.input as Record<string, unknown>).run_in_background = false;
			const verdict = await this.permit({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input as Record<string, unknown> });
			if (!verdict && !this.approvedUpfront(event.toolName, event.input)) this.onApproved?.(event.toolCallId, event.toolName);
			return verdict;
		});
	};

	/** Asks the user (unless the tool runs without asking); a block verdict when it must not run. Also for subagents' tools. */
	private async permit(call: { toolCallId: string; toolName: string; input: Record<string, unknown> }, subagentId?: string): Promise<{ block: true; reason: string } | undefined> {
		const log = this.backend.log;
		if (this.approvedUpfront(call.toolName, call.input)) return undefined;
		if (!this.ask) return { block: true, reason: "No client to ask for permission." };
		const decision = await this.ask({
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			title: toolTitle(call.toolName, call.input),
			toolKind: toolKind(call.toolName),
			input: call.input,
			locations: toolLocations(call.input, this.cwd),
			...(subagentId ? { subagentId } : {}),
		}).catch((err: unknown) => {
			log.error(`session ${this.id}: permission request failed: ${(err as Error)?.message ?? String(err)}`);
			return "reject" as const;
		});
		log.info(`session ${this.id}${subagentId ? ` subagent ${subagentId}` : ""}: permission ${call.toolName} ${call.toolCallId} -> ${decision}`);
		if (decision === "allow_always") this.alwaysAllowed.add(call.toolName);
		if (decision === "reject") return { block: true, reason: "The user rejected this tool call." };
		return undefined;
	}

	/** Runs a turn, tracking its phase so messages typed meanwhile (steer) know where to go. */
	async prompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk, askUser?: QuestionAsk): Promise<TurnResult> {
		this.askUser = askUser;
		this.phase = "dispatching";
		this.dispatched = new Promise<void>((resolve) => (this.endDispatch = resolve));
		try {
			return await this.runPrompt(input, sink, signal, ask);
		} finally {
			this.askUser = undefined;
			this.enterPhase("idle");
		}
	}

	private enterPhase(phase: PiSession["phase"]): void {
		this.phase = phase;
		if (phase !== "dispatching") this.endDispatch();
	}

	/**
	 * A message typed while the turn runs: queued with Pi's steer(), so Pi reads it after the tools
	 * running now and before its next model call. Skills expand into the running task; other commands
	 * (/compact) would start their own turn, so they are "busy".
	 */
	async steer(input: PromptInput): Promise<SteerResult> {
		const log = this.backend.log;
		const command = input.command;
		const skill = !!command && (await this.commands()).some((c) => c.kind === "skill" && c.name === command.name);
		if (this.phase === "dispatching") await this.dispatched;
		// No awaits from here until the message is registered in steersInFlight: the turn's end checks it.
		if (this.phase === "command") return "busy";
		const pi = this.pi;
		if (this.phase !== "running" || !pi) return "not_running";
		if (command && !skill) {
			log.info(`session ${this.id}: steering with /${command.name} refused, the turn is busy`);
			return "busy";
		}
		let text = skill ? `/skill:${command!.name}${command!.args ? ` ${command!.args}` : ""}` : input.text;
		let images = input.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
		if (images.length && pi.model && !pi.model.input.includes("image")) {
			log.warn(`session ${this.id}: ${pi.model.id} does not accept images; ${images.length} steered image(s) dropped`);
			text = `${text}\n\n[${images.length} image(s) omitted: ${pi.model.name} does not accept images]`.trim();
			images = [];
		}
		const queued = pi.steer(text, images);
		this.steersInFlight.add(queued);
		const settled = () => void this.steersInFlight.delete(queued);
		queued.then(settled, settled);
		await queued;
		log.info(`session ${this.id}: steered message queued (${text.length} chars, ${images.length} image(s))`);
		return "injected";
	}

	private async runPrompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk): Promise<TurnResult> {
		let { text } = input;
		if (signal.aborted) return { stop: "cancelled" };
		const command = input.command;
		if (command?.name === "compact") {
			this.enterPhase("command");
			return this.compact(command.args, sink);
		}
		// A skill command runs through Pi's own skill invocation (loads SKILL.md, appends the task).
		const skillCommand = command && (await this.commands()).some((c) => c.kind === "skill" && c.name === command.name);
		if (skillCommand) text = `/skill:${command.name}${command.args ? ` ${command.args}` : ""}`;
		const log = this.backend.log;
		const ref = this.currentModel();
		const model = this.backend.resolveModel(ref);
		if (this.model && ref !== this.model) log.warn(`session ${this.id}: selected model ${fmt(this.model)} is no longer available, using ${fmt(ref)}`);
		if (!ref || !model) {
			log.error(`session ${this.id}: prompt rejected, no provider bound`);
			return {
				stop: "error",
				error: "No model available: the IDE has not configured any provider for Pi.",
				failure: { category: "request", title: "No model available", details: "The IDE has not configured any AI provider for Pi. Choose an AI source or add an API key.", actions: [] },
			};
		}
		if (this.model !== ref) {
			this.model = ref;
			this.persist();
		}
		if (!this.pi) {
			// The form tool exists only when the client can show forms; it asks through the running turn's QuestionAsk.
			const askUser = this.context.questionForms ? askUserTool(() => this.askUser) : undefined;
			this.pi = await this.backend.createPiSession(this.id, this.cwd, model, this.thinkingLevel(), this.gate, this.context, askUser);
		}
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
		const transcript = new TranscriptStream(sink, {
			cwd: this.cwd,
			phaseHold: this.backend.phaseHold,
			needsApproval: (name, input) => !this.approvedUpfront(name, input),
			launchesSubagent: (name) => name === AGENT_TOOL,
			log: (line) => log.info(`session ${this.id}: ${line}`),
		});
		this.ask = ask;
		this.onApproved = (id, name) => transcript.approved(id, name);
		this.logMcpToolsOnce();
		const subagents = new SubagentRelay({
			parentId: this.id,
			cwd: this.cwd,
			sink,
			gate: (subagentId, call) => this.permit(call, subagentId),
			needsApproval: (name, input) => !this.approvedUpfront(name, input),
			phaseHold: this.backend.phaseHold,
			log,
		});
		const unsubscribe = pi.subscribe((event) => {
			transcript.handle(event);
			if (event.type === "tool_execution_start" && event.toolName === AGENT_TOOL) subagents.agentCallStarted(event.toolCallId, event.args);
			if (event.type === "tool_execution_end" && event.toolName === AGENT_TOOL) subagents.agentCallEnded(event.toolCallId, event.isError, signal.aborted);
			if (event.type === "message_end" && event.message.role === "assistant") {
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
		this.enterPhase("running");
		try {
			await withChildHost(subagents, async () => {
				await pi.prompt(text, { images, expandPromptTemplates: !!skillCommand });
				await this.drainSteering(pi, signal);
			});
		} catch (err) {
			log.error(`session ${this.id}: prompt threw after ${Date.now() - started}ms: ${(err as Error).stack ?? String(err)}`);
			return { stop: signal.aborted ? "cancelled" : "error", error: (err as Error).message, failure: classifyFailure((err as Error).message) };
		} finally {
			this.enterPhase("idle");
			transcript.flush(); // an aborted or failed message still shows what it wrote
			subagents.close(signal.aborted);
			unsubscribe();
			this.ask = undefined;
			this.onApproved = undefined;
			this.logMcpToolsOnce(); // servers may only have connected during this turn
			signal.removeEventListener("abort", onAbort);
		}
		const took = Date.now() - started;
		const tokens = last ? `in=${total.input} out=${total.output} cost=$${total.cost.toFixed(5)}` : "no assistant message";
		if (last?.stopReason === "error") log.error(`session ${this.id}: prompt failed after ${took}ms (${tokens}): ${last.errorMessage}`);
		else log.info(`session ${this.id}: prompt done after ${took}ms stop=${signal.aborted ? "cancelled" : last?.stopReason} ${tokens}`);
		if (signal.aborted || last?.stopReason === "aborted") return { stop: "cancelled" };
		const usage = last && { inputTokens: total.input, outputTokens: total.output, cachedReadTokens: total.cacheRead, cachedWriteTokens: total.cacheWrite };
		if (last?.stopReason === "error") {
			const error = last.errorMessage ?? "model error";
			return { stop: "error", error, usage, failure: classifyFailure(error, { overflow: isContextOverflow(last, model.contextWindow) }) };
		}
		if (last?.stopReason === "length") return { stop: "max_tokens", usage };
		return { stop: "end_turn", usage };
	}

	/**
	 * Pi reads queued messages between model calls; one that arrives after its last check stays queued.
	 * Run those in the same turn so a steered message is never lost. Returns with no await after the
	 * final check, so the caller can leave the "running" phase before another steer can slip in.
	 */
	private async drainSteering(pi: AgentSession, signal: AbortSignal): Promise<void> {
		for (;;) {
			if (this.steersInFlight.size) {
				await Promise.allSettled([...this.steersInFlight]);
				continue;
			}
			if (pi.pendingMessageCount === 0) return;
			const { steering, followUp } = pi.clearQueue();
			const late = [...steering, ...followUp];
			if (signal.aborted) {
				this.backend.log.info(`session ${this.id}: turn cancelled, ${late.length} steered message(s) dropped`);
				return;
			}
			this.backend.log.info(`session ${this.id}: ${late.length} steered message(s) arrived as Pi finished, continuing the turn`);
			await pi.prompt(late.join("\n\n"), { expandPromptTemplates: false });
		}
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
/** Brave Mode default, as Junie for users without a stored choice: read-only commands run, the rest asks. */
const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";
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

/**
 * Pi extension registering the client's MCP servers for one session, tools exposed directly to the model.
 * With the Junie router alias, the IDE server's `execute_tool` is callable but not declared (see junie-compat.ts).
 */
function registerClientMcpServers(servers: McpServerSpec[], compat: JunieCompatOptions) {
	return (pi: ExtensionAPI) => {
		for (const s of servers) {
			const name = s.name.replace(/[^A-Za-z0-9_-]/g, "_");
			const toolExposure = s.name === IDE_SERVER ? ideServerToolExposure(compat) : undefined;
			const exposure = { exposure: "direct" as const, ...(toolExposure ? { toolExposure } : {}) };
			if (s.transport === "stdio") pi.registerMcpServer(name, { command: s.command, args: s.args, env: s.env, ...exposure });
			else pi.registerMcpServer(name, { type: "http", url: s.url, headers: s.headers, ...exposure });
		}
	};
}
