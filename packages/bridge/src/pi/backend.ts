// Pi bridge: implements the core AgentBackend port with Pi's SDK.
// Knows Pi (ModelRuntime, AgentSession); knows nothing about ACP.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import type { AgentBackend, BackendSession, PermissionAsk, PlanReviewAsk, QuestionAsk, SessionContext, TurnSink } from "../core/ports.ts";
import type { ApprovalMode, CommandInfo, HistoryItem, PlanUpdate, McpServerSpec, ModelChoice, ModelGroup, ModelMix, ModelRef, PromptInput, ProviderBinding, ProviderSlotState, SessionSummary, SteerResult, TurnResult } from "../core/types.ts";
import type { JunieCredentials, JunieModelChoice } from "pi-junie-config/credentials";
import { formatCredits, formatStatsNumber, reportedCost, sessionUsage, totalTokens } from "pi-junie-config/usage";
import { ECO_MODELS, ECO_PROVIDER, ecoRoute, IMPLEMENTATION_MODEL_IDS, registerEcoTarget } from "pi-junie-cost/router";
import { profileModelId, profileProvider } from "pi-junie-config/profile-provider";
import type { JunieProfile } from "pi-junie-config/profiles";
import { jetbrainsAiProvider } from "pi-junie-jetbrains-ai";
import { bridgeProviderId, CUSTOM_MODELS_GROUP, DEFAULT_MODEL, JETBRAINS_AI_GROUP, joinBaseUrl, keyAuthHeaders, SLOTS, type SlotDefinition, VENDOR_ROUTES, vertexBaseUrl } from "./catalog.ts";
import { openPiTranscript, type SessionMeta, SessionStore } from "./session-store.ts";
import { BRIDGE_TOOLS, READ_ONLY_TOOLS, toolKind, toolLocations, toolResultText, toolTitle } from "./tools.ts";
import { IDE_ROUTER_TOOL, IDE_SERVER, ideRouterName, ideServerToolExposure, JUNIE_COMPAT_DEFAULTS, type JunieCompatOptions, junieExecuteToolAlias } from "./junie-compat.ts";
import { classifyFailure } from "./failures.ts";
import { PLACEHOLDER_API_KEY } from "./proxy-auth.ts";
import { ASK_USER_TOOL, askUserTool } from "./ask-user.ts";
import { type PhaseSplitterOptions, signaturePhase } from "./phases.ts";
import { TranscriptStream } from "./transcript.ts";
import { TODO_TOOL, todoPlan } from "./todo.ts";
import { PLAN_COMPLETE_TOOL, PLAN_MODE_PLUGIN, PLAN_MODE_TOOLS, readPlanModeState, REVIEW_PLAN_ID, runPlanCommand } from "./plan-mode.ts";
import { FLAG_ECO_MODE_IMPLEMENTATION, FLAG_JUNIE_MIXES, type FeatureFlags, INGRAZZIO_SLOT, ingrazzioProvider, JUNIE_LITE, loadFeatureFlags } from "./ingrazzio.ts";
import { type MixCatalog, parseMixCatalog } from "./mixes.ts";
import { isReadOnlyCommand } from "./safe-commands.ts";
import { FETCH_CONTENT_TOOL, WEB_READ_TOOLS, withoutBackgroundFetch } from "./web-access.ts";
import { AGENT_TOOL, installChildSessionHook, markBridgeSession, SubagentRelay, subagentModelsNote, withChildHost } from "./subagents.ts";
import { bundledPlugin, type DetectedPlugin, detectPlugins, has, pluginTools, pluginWelcomeLines, SUBAGENT_TOOLS, SUBAGENTS_PLUGIN, TODO_PLUGIN, TODO_TOOLS } from "./plugins.ts";
import { discoverModels, type ListedModel, listingIdMatches } from "./discovery.ts";

function ideRouterNote(name: string): string {
	return `The IDE tool \`${name}\` runs IDE tools by name: \`command: "<tool> --param value ..."\`. Use it when the user asks you to do something in the IDE, or when a skill you read for the task directs you to. Take tool names from such skills, from the router's own description, or from its error messages (they say which parameter is missing). Do not cycle through guessed names: after one 'not found', tell the user which IDE capability seems to be missing.`;
}

/**
 * Where the agent runs, from the client's own introduction (ACP initialize `clientInfo`); no client is assumed.
 * The `@path` line is about how mentions read, not about a particular client.
 */
function clientNote(client: SessionContext["client"]): string {
	const known = client && client.name !== "unknown";
	const where = known ? `${client.title ?? client.name} (an Agent Client Protocol client)` : "an Agent Client Protocol client";
	return (
		`You are running inside ${where}. The user sees your Markdown answers and your tool calls there; edits and commands may need their approval.\n` +
		"If the user's message mentions a file or folder as `@path`, the `@` is not part of the name: `create @notes/a.txt` means the file `notes/a.txt`."
	);
}

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
	/**
	 * Junie's configuration from the environment (packages/junie-config): keys bind models without a client, the
	 * model choice is the default of new sessions. `vendorBaseUrls` replaces a vendor's public API (tests).
	 */
	junie?: { credentials?: JunieCredentials; model?: JunieModelChoice; profiles?: JunieProfile[]; vendorBaseUrls?: Record<string, string> };
	/** Plugins that ship with the bridge: package directories loaded into every session (e.g. packages/junie-cost). */
	bundledPlugins?: string[];
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
	/** The Ingrazzio route (no models) and the feature flags read through it. */
	private ingrazzio?: { binding: ProviderBinding; generation: number; flags?: FeatureFlags; mixes?: MixCatalog };
	/** The JetBrains AI group is registered (JUNIE_API_KEY). */
	private jetbrainsAi = false;
	private junieModel: JunieModelChoice = {};
	/** Eco mode as last chosen per model (`slot/model` -> on), kept across sessions like Junie's acpEcoModePerModel. */
	private ecoChoices: Record<string, boolean>;
	private readonly ecoChoicesFile: string;
	/** Eco models registered in the runtime, by id (`slot/model`). */
	private readonly ecoRegistered = new Set<string>();
	/** Junie's custom model profiles: slot `custom:<id>` -> its provider and default thinking level. */
	private profiles = new Map<string, { providerId: string; defaultLevel?: string }>();
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
		this.ecoChoicesFile = join(stateDir, "eco.json");
		try {
			this.ecoChoices = JSON.parse(readFileSync(this.ecoChoicesFile, "utf8")) as Record<string, boolean>;
		} catch {
			this.ecoChoices = {};
		}
		this.agentDir = join(stateDir, "agent");
		this.log = options.logger ?? silentLogger;
		this.version = options.version ?? "0.0.0";
		this.fetchImpl = options.fetch;
		this.discoveryTimeoutMs = options.discoveryTimeoutMs;
		this.trustProject = options.trustProject ?? true;
		this.phaseHold = options.phaseHold;
		this.junieCompat = { ...JUNIE_COMPAT_DEFAULTS, ...options.junieCompat };
		this.plugins = [
			...(options.bundledPlugins ?? []).flatMap((dir) => bundledPlugin(dir, this.log) ?? []),
			...(options.piAgentDir ? detectPlugins(options.piAgentDir, this.log) : []),
		];
		if (this.plugins.some((p) => p.name === SUBAGENTS_PLUGIN)) {
			installChildSessionHook();
			// The plugin saves its children as ordinary Pi sessions in Pi's default session dir (its `rememberAgents`),
			// where the IDE lists them as Pi chats. In this process they belong to the bridge: keep them in its state dir.
			// (Bridge sessions always pass their own dir, so only the plugin reads this.)
			process.env.PI_CODING_AGENT_SESSION_DIR = join(stateDir, "subagents");
			this.log.info(`subagent transcripts go to ${process.env.PI_CODING_AGENT_SESSION_DIR}`);
		}
		this.showWelcome = options.welcome ?? false;
		this.junieModel = options.junie?.model ?? {};
		if (options.junie?.credentials) this.useJunieCredentials(options.junie.credentials, options.junie.vendorBaseUrls ?? {});
		for (const profile of options.junie?.profiles ?? []) this.useJunieProfile(profile);
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
		})).concat({
			id: INGRAZZIO_SLOT.id,
			displayName: INGRAZZIO_SLOT.displayName,
			supportedApiTypes: [INGRAZZIO_SLOT.apiType],
			required: false,
			binding: this.ingrazzio?.binding,
		});
	}

	/** The Ingrazzio route: the account's feature flags, and Junie Lite (offered without discovery, like Junie). */
	private bindIngrazzio(binding: ProviderBinding): void {
		const generation = ++this.generation;
		this.ingrazzio = { binding, generation };
		this.runtime.registerProvider(bridgeProviderId(INGRAZZIO_SLOT.id), ingrazzioProvider(binding, PLACEHOLDER_API_KEY));
		this.emit();
		this.log.info(`bind ${INGRAZZIO_SLOT.id}: apiType=${binding.apiType} baseUrl=${binding.baseUrl} headers=[${Object.keys(binding.headers).join(", ")}] -> loading feature flags`);
		const done = loadFeatureFlags(binding, { fetch: this.fetchImpl, log: this.log }).then((flags) => {
			if (this.ingrazzio?.generation !== generation) return;
			this.ingrazzio.flags = flags;
			this.ingrazzio.mixes = flags.kind === "loaded" ? parseMixCatalog(flags.values[FLAG_JUNIE_MIXES], this.log) : undefined;
			this.emit();
		});
		this.pending.add(done);
		void done.finally(() => this.pending.delete(done));
	}

	/**
	 * Junie's keys, as Junie's CLI uses them: `JUNIE_API_KEY` adds the JetBrains AI group (Junie's catalog through
	 * Ingrazzio); a vendor key binds that vendor's slot to the vendor's API. A client's providers/set for the same slot
	 * later replaces the key binding, so in AIR the IDE's providers win.
	 */
	private useJunieCredentials(credentials: JunieCredentials, vendorBaseUrls: Record<string, string>): void {
		if (credentials.junieApiKey) {
			// The provider reads JUNIE_API_KEY from the environment itself (packages/jetbrains-ai/src/api-key.ts).
			this.runtime.registerNativeProvider(jetbrainsAiProvider());
			this.jetbrainsAi = true;
			const count = this.runtime.getModels().filter((m) => m.provider === JETBRAINS_AI_GROUP.providerId).length;
			this.log.info(`Junie key: JetBrains AI group with ${count} models (JUNIE_API_KEY)`);
		}
		for (const { vendor, env, apiKey } of credentials.vendorKeys) {
			const route = VENDOR_ROUTES[vendor];
			if (!route) continue;
			this.log.info(`Junie key: ${vendor} bound to the vendor API (${env})`);
			this.bindProvider({ slotId: vendor, apiType: route.apiType, baseUrl: vendorBaseUrls[vendor] ?? route.baseUrl, headers: {}, apiKey });
		}
		for (const env of credentials.unsupported) this.log.warn(`Junie key: ${env} is set but not supported yet; ignored`);
	}

	/** A Junie custom model profile as its own provider (packages/junie-config/src/profile-provider.ts). */
	private useJunieProfile(profile: JunieProfile): void {
		const provider = profileProvider(profile, PLACEHOLDER_API_KEY);
		this.runtime.registerProvider(provider.providerId, provider.config);
		this.profiles.set(profileModelId(profile.profileId), { providerId: provider.providerId, defaultLevel: provider.defaultLevel });
		const m = profile.primary;
		this.log.info(
			`Junie profile ${profile.profileId} (${profile.path}): ${m.apiType} ${m.id} at ${provider.config.baseUrl}${m.apiKey ? " key=<set>" : ""}` +
				`${m.efforts ? ` efforts=[${m.efforts.join(", ")}]` : ""}${profile.faster.id !== m.id ? ` (fasterModel ${profile.faster.id} not used)` : ""}`,
		);
	}

	bindProvider(binding: ProviderBinding): void {
		if (binding.slotId === INGRAZZIO_SLOT.id) return this.bindIngrazzio(binding);
		const previous = this.bindings.get(binding.slotId)?.binding;
		if (previous?.apiKey && !binding.apiKey) this.log.info(`bind ${binding.slotId}: the client's binding replaces the Junie key binding`);
		const slot = this.slot(binding.slotId);
		const target = slot.apiTypes[binding.apiType];
		if (!target) throw new Error(`slot ${slot.id} has no apiType ${binding.apiType}`);
		// A new binding invalidates the previous one's models until discovery answers (no fallback list).
		this.runtime.unregisterProvider(bridgeProviderId(slot.id));
		const generation = ++this.generation;
		this.bindings.set(slot.id, { binding, generation, status: "discovering" });
		this.log.info(
			`bind ${slot.id}: apiType=${binding.apiType} baseUrl=${binding.baseUrl} headers=[${Object.keys(binding.headers).join(", ")}]${binding.apiKey ? " key=<set>" : ""}` +
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
			{ apiType: binding.apiType, baseUrl: binding.baseUrl, headers: { ...binding.headers, ...(binding.apiKey ? keyAuthHeaders(binding.apiType, binding.apiKey) : {}) } },
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
				// A vendor key goes as the vendor's own auth. Through the proxy Pi still needs a key: a placeholder that
				// withoutPlaceholderAuth removes from requests (see proxy-auth.ts).
				apiKey: binding.apiKey ?? PLACEHOLDER_API_KEY,
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
		if (slotId === INGRAZZIO_SLOT.id) {
			this.log.info(`unbind ${slotId}: ${this.ingrazzio ? "feature flags and Junie Lite dropped" : "was not bound"}`);
			this.ingrazzio = undefined;
			this.runtime.unregisterProvider(bridgeProviderId(slotId));
			this.emit();
			return;
		}
		if (!this.bindings.delete(slotId)) {
			this.log.info(`unbind ${slotId}: was not bound`);
			return;
		}
		this.runtime.unregisterProvider(bridgeProviderId(slotId));
		this.log.info(`unbind ${slotId}: bound slots now [${[...this.bindings.keys()].join(", ")}]`);
		this.emit();
	}

	availableModels(): ModelGroup[] {
		const slots = [
			...SLOTS.filter((s) => this.bindings.has(s.id)),
			...(this.ingrazzio ? [INGRAZZIO_SLOT] : []),
			...(this.jetbrainsAi ? [JETBRAINS_AI_GROUP] : []),
		];
		const custom: ModelGroup[] = this.profiles.size
			? [{ slotId: CUSTOM_MODELS_GROUP.id, name: CUSTOM_MODELS_GROUP.displayName, models: [...this.profiles].flatMap(([slotId, p]) => this.runtime.getModels().filter((m) => m.provider === p.providerId).map((m): ModelChoice => ({ slotId, modelId: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning }))) }]
			: [];
		return [
			...slots.map((s) => ({
				slotId: s.id,
				name: s.displayName,
				models: this.runtime
					.getModels()
					// junie-cost registers its own `jetbrains-ai/<id>-eco` models; the bridge offers Eco as a switch instead.
					.filter((m) => m.provider === bridgeProviderId(s.id) && !(s.id === JETBRAINS_AI_GROUP.id && m.id.endsWith("-eco")))
					.map((m): ModelChoice => ({ slotId: s.id, modelId: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning, ...(this.ecoLevels({ slotId: s.id, modelId: m.id }) ? { eco: true } : {}) })),
			})),
			...custom,
		];
	}

	/** The Default group: the catalog's levels whose model (and effort) this bridge can run now, in catalog order. */
	modelMixes(): ModelMix[] {
		const catalog = this.ingrazzio?.mixes;
		if (!catalog) return [];
		const out: ModelMix[] = [];
		for (const preset of catalog.presets) {
			const ref = this.modelForSetting(preset.modelId);
			const model = ref && this.resolveModel(ref);
			if (!ref || !model) continue;
			const levels = getSupportedThinkingLevels(model).filter((l) => l !== "off");
			const effort = preset.effort === "none" ? undefined : preset.effort;
			if (effort && !levels.includes(effort as (typeof levels)[number])) continue; // the model can't run the level's effort
			const ecoLevels = this.ecoLevels(ref);
			const eco = preset.eco && !!ecoLevels && !!effort && ecoLevels.includes(effort as (typeof ecoLevels)[number]);
			out.push({ id: preset.id, label: preset.label, description: preset.description, model: ref, modelName: model.name, ...(effort ? { effort } : {}), recommended: preset.id === catalog.recommended, ...(eco ? { eco } : {}) });
		}
		return out;
	}

	/** The efforts at which a model accepts Eco mode (Junie's ecoModeEfforts), undefined when it has no Eco mode. */
	ecoLevels(ref: ModelRef | undefined): readonly string[] | undefined {
		if (!ref || ref.slotId.startsWith("custom:")) return undefined;
		return ECO_MODELS.find((e) => listingIdMatches(ref.modelId, e.id))?.thinkingLevels;
	}

	/** Eco mode for a model without a choice in the session: the remembered choice, else MODEL_MIX_ENABLED, else off. */
	ecoDefault(ref: ModelRef): boolean {
		return this.ecoChoices[`${ref.slotId}/${ref.modelId}`] ?? this.junieModel.modelMix ?? false;
	}

	rememberEco(ref: ModelRef, on: boolean): void {
		this.ecoChoices[`${ref.slotId}/${ref.modelId}`] = on;
		try {
			writeFileSync(this.ecoChoicesFile, JSON.stringify(this.ecoChoices, null, 2));
		} catch (err) {
			this.log.warn(`Eco choices not saved: ${(err as Error).message}`);
		}
	}

	/**
	 * The Eco model of `ref`: a virtual model (provider `eco`) that junie-cost's router sends to `ref` while the task
	 * plans and to the implementation model (GPT-6 Luna, else Claude Haiku 5.5, from any provider) after the plan.
	 */
	ecoModel(ref: ModelRef): Model<Api> | undefined {
		const primary = this.resolveModel(ref);
		const levels = this.ecoLevels(ref);
		if (!primary || !levels) return undefined;
		const id = `${ref.slotId}/${ref.modelId}`;
		if (!this.ecoRegistered.has(id)) {
			const target = {
				primary: () => this.resolveModel(ref),
				implementation: () => this.ecoImplementation(),
				implementationLevel: () => this.ecoImplementationFlag()?.effort as "high" | undefined,
				primaryLabel: fmt(ref),
			};
			registerEcoTarget(id, target);
			this.runtime.registerVirtualModel({
				provider: ECO_PROVIDER,
				id,
				name: `${primary.name} (Eco)`,
				thinkingLevels: [...levels] as (typeof ECO_MODELS)[number]["thinkingLevels"],
				contextWindow: primary.contextWindow,
				route: (request) => ecoRoute(target, request),
			});
			this.ecoRegistered.add(id);
			this.log.info(`Eco model ${ECO_PROVIDER}/${id} registered (implementation model now: ${this.ecoImplementation()?.id ?? "none, the primary model implements"})`);
		}
		return this.runtime.getModel(ECO_PROVIDER, id);
	}

	/** The account's `ECO_MODE_IMPLEMENTATION` flag (`{modelId, effort}`, from Ingrazzio), as Junie reads it. */
	private ecoImplementationFlag(): { modelId: string; effort: string } | undefined {
		const flags = this.ingrazzio?.flags;
		const value = flags?.kind === "loaded" ? (flags.values[FLAG_ECO_MODE_IMPLEMENTATION] as { modelId?: unknown; effort?: unknown } | undefined) : undefined;
		return typeof value?.modelId === "string" && typeof value.effort === "string" ? { modelId: value.modelId, effort: value.effort } : undefined;
	}

	/**
	 * Junie's implementation model: the account flag's model when a provider offers it, else the first of Junie's
	 * preferred models any provider offers.
	 */
	private ecoImplementation(): Model<Api> | undefined {
		const flagged = this.ecoImplementationFlag()?.modelId;
		for (const id of [...(flagged ? [flagged] : []), ...IMPLEMENTATION_MODEL_IDS]) {
			for (const group of this.availableModels()) {
				const found = group.models.find((m) => listingIdMatches(m.modelId, id));
				if (found) return this.resolveModel(found);
			}
		}
		return undefined;
	}

	/** A model by Junie's setting id (the mixes catalog's `modelId`). */
	private modelForSetting(settingId: string): ModelRef | undefined {
		if (settingId === JUNIE_LITE.settingId) return this.ingrazzio ? { slotId: INGRAZZIO_SLOT.id, modelId: JUNIE_LITE.id } : undefined;
		const profile = this.profiles.get(settingId); // a custom model profile, `custom:<profileId>`
		if (profile) {
			const model = this.runtime.getModels().find((m) => m.provider === profile.providerId);
			return model ? { slotId: settingId, modelId: model.id } : undefined;
		}
		for (const group of this.availableModels()) {
			const found = group.models.find((m) => listingIdMatches(m.modelId, settingId));
			if (found) return { slotId: found.slotId, modelId: found.modelId };
		}
		return undefined;
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
		const configured = this.configuredModel();
		if (configured) {
			// Junie's JUNIE_MODEL / JUNIE_EFFORT (or PRIMARY_MODEL*): the run's model, chosen by configuration.
			const effort = this.configuredEffort(configured);
			Object.assign(meta, { model: configured, ...(effort ? { effort } : {}) });
		} else {
			// Like Junie, a new chat starts on the recommended Default level when there is one.
			const recommended = this.modelMixes().find((m) => m.recommended);
			if (recommended) Object.assign(meta, { mix: recommended.id, model: recommended.model, ...(recommended.effort ? { effort: recommended.effort } : {}) });
		}
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

	async forkSession(context: SessionContext & { sessionId: string }): Promise<BackendSession | undefined> {
		const { sessionId: sourceId, cwd } = context;
		const source = SessionStore.isValidId(sourceId) ? this.store.load(sourceId) : undefined;
		if (!source) {
			this.log.error(`session ${sourceId}: fork rejected, no such session`);
			return undefined;
		}
		const id = `pi-${Date.now().toString(36)}-${++this.counter}`;
		const now = new Date().toISOString();
		// Like Junie: the fork keeps the source's settings and starts in Default mode.
		const meta: SessionMeta = {
			id,
			cwd,
			forkedFrom: sourceId,
			createdAt: now,
			updatedAt: now,
			...(source.model ? { model: source.model } : {}),
			...(source.effort ? { effort: source.effort } : {}),
			...(source.mix ? { mix: source.mix } : {}),
			...(source.approvalMode ? { approvalMode: source.approvalMode } : {}),
			...(source.eco !== undefined ? { eco: source.eco } : {}),
			...(source.title ? { title: source.title } : {}),
			...(source.lastPromptAt ? { lastPromptAt: source.lastPromptAt } : {}),
			...(source.planMode !== undefined ? { planMode: false } : {}),
		};
		const copied = this.store.forkTranscript(source, id, cwd);
		this.store.save(meta);
		this.log.info(`session ${id} forked from ${sourceId} (cwd ${cwd}${cwd === source.cwd ? "" : `, source cwd ${source.cwd}`}): ${copied ? "conversation copied" : "the source has no conversation yet"}`);
		return new PiSession(meta, this, context);
	}

	listSessions({ cwd, limit }: { cwd?: string; limit: number }): SessionSummary[] {
		return this.store
			.list()
			.filter((m) => !cwd || m.cwd === cwd)
			.filter((m) => m.lastPromptAt) // never-prompted chats are not history
			.slice(0, limit)
			.map((m) => ({ id: m.id, cwd: m.cwd, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, lastPromptAt: m.lastPromptAt, forkedFrom: m.forkedFrom, costUsd: m.costUsd }));
	}

	/** Resolves a ModelRef to the Pi model registered for its binding. */
	resolveModel(ref: ModelRef | undefined): Model<Api> | undefined {
		if (!ref) return undefined;
		return this.runtime.getModel(bridgeProviderId(ref.slotId), ref.modelId);
	}

	/**
	 * The effort Junie's configuration names, as the model's Pi level: JUNIE_EFFORT, a profile's own effort name mapped
	 * through its thinking-level map; else a profile's defaultEffort. `none` means no effort setting.
	 */
	private configuredEffort(ref: ModelRef): string | undefined {
		const wanted = this.junieModel.effort;
		if (!wanted) return this.profiles.get(ref.slotId)?.defaultLevel;
		if (wanted === "none") return undefined;
		const map = this.resolveModel(ref)?.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
		return Object.entries(map ?? {}).find(([, v]) => v?.toLowerCase() === wanted)?.[0] ?? wanted;
	}

	/** The model Junie's configuration names (JUNIE_MODEL / PRIMARY_MODEL), when it is available. */
	private configuredModel(): ModelRef | undefined {
		if (!this.junieModel.model) return undefined;
		const ref = this.modelForSetting(this.junieModel.model);
		if (!ref) this.log.warn(`Junie model ${this.junieModel.model} is not among the available models; using the default`);
		return ref;
	}

	defaultModel(): ModelRef | undefined {
		const configured = this.junieModel.model ? this.modelForSetting(this.junieModel.model) : undefined;
		if (configured) return configured;
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
			appendSystemPrompt: [clientNote(context.client), ...(hasIde ? [ideRouterNote(ideRouterName(this.junieCompat))] : [])],
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
			tools: [...BRIDGE_TOOLS, "mcp__*", ...(routerAlias ? [IDE_ROUTER_TOOL] : []), ...(askUser ? [ASK_USER_TOOL] : []), ...pluginTools(this.plugins)],
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

	/** The plan-mode plugin is loaded. */
	planModeAvailable(): boolean {
		return has(this.plugins, PLAN_MODE_PLUGIN);
	}

	/** The todo plugin is loaded: `todo` calls are shown as the session's plan. */
	todoPlans(): boolean {
		return has(this.plugins, TODO_PLUGIN);
	}

	private slot(id: string): SlotDefinition {
		const slot = SLOTS.find((s) => s.id === id);
		if (!slot) throw new Error(`unknown provider slot ${id}`);
		return slot;
	}

	private emit() {
		this.logMixesIfChanged();
		for (const l of this.listeners) l();
	}

	private loggedMixes?: string;

	/** The Default group depends on the catalog and on every slot's discovery, so it is logged whenever it changes. */
	private logMixesIfChanged(): void {
		if (!this.ingrazzio?.mixes) return;
		const line = this.modelMixes()
			.map((m) => `${m.id}=${fmt(m.model)}${m.effort ? `@${m.effort}` : ""}${m.recommended ? "*" : ""}`)
			.join(", ");
		if (line === this.loggedMixes) return;
		this.loggedMixes = line;
		this.log.info(`mixes: Default group [${line}]`);
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
		this.meta.mix = undefined; // like Junie: changing the effort of a level makes the choice manual
		this.persist();
		this.pi?.setThinkingLevel(this.thinkingLevel());
	}

	approvalMode(): ApprovalMode {
		return this.meta.approvalMode ?? DEFAULT_APPROVAL_MODE;
	}

	planMode(): boolean | undefined {
		return this.backend.planModeAvailable() ? this.meta.planMode === true : undefined;
	}

	async selectPlanMode(on: boolean): Promise<void> {
		if (!this.backend.planModeAvailable()) throw new Error("Plan mode needs the plan-mode plugin");
		this.backend.log.info(`session ${this.id}: plan mode ${this.planMode() ? "on" : "off"} -> ${on ? "on" : "off"}`);
		this.meta.planMode = on;
		this.persist();
	}

	/** Brings the plugin's mode in line with the user's choice (before a prompt; the plugin switches only when idle). */
	private async syncPlanMode(pi: AgentSession, sink: TurnSink): Promise<void> {
		if (!this.backend.planModeAvailable()) return;
		const actual = readPlanModeState(pi).enabled;
		if (this.meta.planMode === undefined) this.meta.planMode = actual; // a chat from before: the plugin's own state
		if (this.meta.planMode === actual) return;
		await runPlanCommand(pi, this.meta.planMode ? "/plan start" : "/plan exit", 0);
		const now = readPlanModeState(pi).enabled;
		this.backend.log.info(`session ${this.id}: plan mode plugin ${actual ? "on" : "off"} -> ${now ? "on" : "off"}`);
		if (now !== this.meta.planMode) {
			sink({ kind: "text", delta: `Plan mode could not be switched ${this.meta.planMode ? "on" : "off"} (see the agent log).\n\n`, phase: "commentary" });
			this.meta.planMode = now;
			sink({ kind: "settings_changed" });
		}
		this.persist();
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
			...(this.backend.planModeAvailable()
				? [{ name: PLAN_COMMAND, description: "Switch to plan mode with an optional task, or leave it with /plan off", hint: "describe what to plan, or use 'off'", kind: "plan_mode" } satisfies CommandInfo]
				: []),
			{ name: "compact", description: "Summarize the conversation so far to free up context", hint: "optional instructions for the summary", kind: "builtin" },
			{ name: "stats", description: "Tokens and cost of this chat: per model and per prompt", kind: "builtin", aliases: ["usage", "cost", "credits"] },
			...resourceLoader.getSkills().skills.map(
				(sk): CommandInfo => ({ name: sk.name, description: sk.description, hint: "optional task for the skill", kind: "skill", skillPath: sk.filePath }),
			),
		]);
		return this.commandList;
	}

	/** `/compact [instructions]`: Pi's compaction of the current conversation. */
	/** Usage of this chat from its transcript (so it survives restarts): Junie Lite counts as free. */
	private usage(pending?: AssistantMessage) {
		const manager = this.pi?.sessionManager ?? openPiTranscript(this.backend.store, this.id, this.cwd);
		const entries = manager?.getEntries() ?? [];
		// A response that has ended but is not in the transcript yet still counts.
		const missing = pending && !entries.some((e) => e.type === "message" && e.message === pending);
		return sessionUsage(missing ? [...entries, { type: "message", message: pending }] : entries, (provider, model) => provider === bridgeProviderId(INGRAZZIO_SLOT.id) && model === JUNIE_LITE.id);
	}

	/** Junie's /stats report for the current session (JUNIE-6310): tokens and credits, per model and per prompt. */
	private statsReport(): string {
		const usage = this.usage();
		const line = (s: string) => `${s}  \n`;
		const cost = reportedCost(usage);
		const out = [line("**Pi stats**"), "\n", line("**Current session**"), line(`- Tokens: ${formatStatsNumber(totalTokens(usage.total))}`)];
		if (cost !== undefined) out.push(line(`- Cost: ${formatCredits(cost)}`));
		out.push(line(`- Model requests: ${usage.total.calls}`));
		if (usage.byModel.size) {
			out.push(line("- Usage by model:"));
			for (const [model, t] of usage.byModel) {
				const input = t.input + t.cacheRead + t.cacheWrite;
				const parts = [`${input} input tokens`, `${t.output} output`, `${t.calls} calls`];
				if (input > 0) parts.push(`${Math.floor((100 * t.cacheRead) / input)}% token cache hit`);
				if (t.cost > 0) parts.push(`cost ${formatCredits(t.cost)}`);
				out.push(line(`  - **${model}**: ${parts.join(", ")}`));
			}
		}
		if (usage.prompts.length) {
			out.push(line(`- Last ${usage.prompts.length} prompts:`));
			for (const p of usage.prompts) {
				const preview = p.preview ? ` ${p.preview} —` : "";
				const promptCost = p.totals.cost > 0 ? `, cost ${formatCredits(p.totals.cost)}` : "";
				out.push(line(`  - **Prompt ${p.index}**:${preview} ${formatStatsNumber(totalTokens(p.totals))} tokens${promptCost}`));
			}
		}
		return out.join("").trimEnd();
	}

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
		const todoPlans = this.backend.todoPlans();
		let plan: PlanUpdate | undefined; // the todo list as it was last
		for (const entry of manager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role: string; content: unknown; toolCallId?: string; isError?: boolean; details?: unknown };
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
								...((todoPlans && part.name === TODO_TOOL) || part.name === PLAN_COMPLETE_TOOL ? { presentsPlan: true } : {}),
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
				if (item.update.presentsPlan && !message.isError) {
					const reviewed = item.update.name === PLAN_COMPLETE_TOOL ? (item.update.input as { plan?: unknown } | undefined)?.plan : undefined;
					if (typeof reviewed === "string" && reviewed.trim()) items.push({ kind: "plan", plan: { kind: "markdown", id: REVIEW_PLAN_ID, content: reviewed.trim() } });
					else plan = todoPlan(message.details) ?? plan;
				}
			}
		}
		if (plan?.kind === "items") items.push({ kind: "plan", plan });
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
		this.meta.mix = undefined;
		this.meta.eco = undefined; // like Junie: the Eco choice is per model, the new model's remembered one applies
		this.persist();
		await this.pi?.setModel(model);
	}

	/** See BackendSession.ecoMode: offered for an explicit model whose current effort accepts Eco. */
	ecoMode(): boolean | undefined {
		if (this.currentMix()) return undefined;
		const ref = this.currentModel();
		const levels = this.backend.ecoLevels(ref);
		const effort = this.currentEffort();
		if (!ref || !levels || !effort || !levels.includes(effort)) return undefined;
		return this.meta.eco ?? this.backend.ecoDefault(ref);
	}

	async selectEcoMode(on: boolean): Promise<void> {
		const ref = this.currentModel();
		if (!ref) return;
		this.backend.log.info(`session ${this.id}: Eco ${on ? "on" : "off"} for ${fmt(ref)}`);
		this.meta.eco = on;
		this.persist();
		this.backend.rememberEco(ref, on);
	}

	/** Eco mode for the next request: a Default level's own, else the explicit model's switch. */
	private ecoActive(): boolean {
		const mix = this.currentMix();
		if (mix) return this.backend.modelMixes().find((m) => m.id === mix)?.eco === true;
		return this.ecoMode() === true;
	}

	/** The level in use while its model and effort are still the session's (the catalog may have moved it). */
	currentMix(): string | undefined {
		const mix = this.backend.modelMixes().find((m) => m.id === this.meta.mix);
		const current = this.currentModel();
		if (!mix || !current || current.slotId !== mix.model.slotId || current.modelId !== mix.model.modelId) return undefined;
		return !mix.effort || this.currentEffort() === mix.effort ? mix.id : undefined;
	}

	async selectMix(id: string): Promise<void> {
		const mix = this.backend.modelMixes().find((m) => m.id === id);
		const model = mix && this.backend.resolveModel(mix.model);
		if (!mix || !model) throw new Error(`Default level ${id} is not available`);
		this.backend.log.info(`session ${this.id}: Default level ${this.meta.mix ?? "none"} -> ${id} (${fmt(mix.model)}${mix.effort ? ` effort ${mix.effort}` : ""})`);
		this.model = mix.model;
		this.meta.mix = id;
		if (mix.effort) this.meta.effort = mix.effort;
		this.persist();
		await this.pi?.setModel(model);
		this.pi?.setThinkingLevel(this.thinkingLevel());
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
	 * Runs without asking: everything in Brave mode; read-only shell commands and web fetches in Auto mode; otherwise
	 * built-in read-only tools, web search, MCP tools the server marks read-only and tools allowed for this chat.
	 */
	private approvedUpfront(toolName: string, input: unknown): boolean {
		const mode = this.approvalMode();
		if (mode === "brave") return true;
		if (mode === "auto" && toolName === "bash" && isReadOnlyCommand(String((input as { command?: unknown } | undefined)?.command ?? ""))) return true;
		// Fetching (pages, PDFs, GitHub clones with the user's gh login) only reads; it asks in Safe mode.
		if (mode === "auto" && toolName === FETCH_CONTENT_TOOL) return true;
		return this.runsWithoutAsking(toolName);
	}

	/** Runs without asking in every mode: built-in read-only tools, web search, MCP tools the server marks read-only, tools allowed for this chat. */
	private runsWithoutAsking(toolName: string): boolean {
		// ask_user is itself a question to the user: no separate permission.
		// The subagent tools only start or steer children, whose own tools pass this gate; the todo tool only edits its list.
		return READ_ONLY_TOOLS.has(toolName) || toolName === ASK_USER_TOOL || SUBAGENT_TOOLS.includes(toolName) || TODO_TOOLS.includes(toolName) || PLAN_MODE_TOOLS.includes(toolName) || WEB_READ_TOOLS.includes(toolName) || this.alwaysAllowed.has(toolName) || this.toolInfo?.(toolName)?.annotations?.readOnlyHint === true;
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
		withoutBackgroundFetch(call.toolName, call.input);
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
	async prompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk, askUser?: QuestionAsk, reviewPlan?: PlanReviewAsk): Promise<TurnResult> {
		this.askUser = askUser;
		this.phase = "dispatching";
		this.dispatched = new Promise<void>((resolve) => (this.endDispatch = resolve));
		try {
			return await this.runPrompt(input, sink, signal, ask, reviewPlan);
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

	private async runPrompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk, reviewPlan?: PlanReviewAsk): Promise<TurnResult> {
		let { text } = input;
		if (signal.aborted) return { stop: "cancelled" };
		const command = input.command;
		if (command?.name === PLAN_COMMAND && this.planMode() !== undefined) {
			// `/plan [task]` switches plan mode on (and plans the task), `/plan off` leaves it.
			const args = command.args.trim();
			if (/^(off|exit|close|stop)$/i.test(args)) {
				await this.selectPlanMode(false);
				sink({ kind: "settings_changed" });
				sink({ kind: "text", delta: "Plan mode is off." });
				return { stop: "end_turn" };
			}
			await this.selectPlanMode(true);
			sink({ kind: "settings_changed" });
			if (!args) {
				sink({ kind: "text", delta: "Plan mode is on: I will investigate and write a plan for you to review before changing anything. Send what to plan." });
				return { stop: "end_turn" };
			}
			text = args;
			input = { ...input, text, command: undefined };
		}
		if (command?.name === "compact") {
			this.enterPhase("command");
			return this.compact(command.args, sink);
		}
		// Junie's /stats (also /usage, /cost, /credits).
		if (command?.name === "stats") {
			this.enterPhase("command");
			sink({ kind: "text", delta: this.statsReport() });
			return { stop: "end_turn" };
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
		// Eco mode: the session runs on the model's Eco model, which routes each request (junie-cost's router).
		const eco = this.ecoActive() ? this.backend.ecoModel(ref) : undefined;
		if (this.ecoActive() && !eco) log.warn(`session ${this.id}: Eco mode is on but ${fmt(ref)} has no Eco model; running without it`);
		const piModel = eco ?? model;
		if (!this.pi) {
			// The form tool exists only when the client can show forms; it asks through the running turn's QuestionAsk.
			const askUser = this.context.questionForms ? askUserTool(() => this.askUser) : undefined;
			this.pi = await this.backend.createPiSession(this.id, this.cwd, piModel, this.thinkingLevel(), this.gate, this.context, askUser);
		}
		// Same model on a new route (a new providers/set, or a client binding replacing a Junie key) counts as a change.
		else if (this.pi.model?.id !== piModel.id || this.pi.model?.provider !== piModel.provider || !sameRoute(this.pi.model, piModel)) await this.pi.setModel(piModel);
		if (this.pi.thinkingLevel !== this.thinkingLevel()) this.pi.setThinkingLevel(this.thinkingLevel());
		const pi = this.pi;
		await this.syncPlanMode(pi, sink);
		const planBefore = this.backend.planModeAvailable() ? readPlanModeState(pi).awaitingPlan : undefined;
		let planSubmitted = false;
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
		log.info(`session ${this.id}: prompt start model=${fmt(ref)}${eco ? ` eco=${eco.provider}/${eco.id}` : ""} effort=${pi.thinkingLevel} api=${model.api} baseUrl=${model.baseUrl} chars=${text.length} images=${images.length}`);

		let last: AssistantMessage | undefined;
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const transcript = new TranscriptStream(sink, {
			cwd: this.cwd,
			phaseHold: this.backend.phaseHold,
			needsApproval: (name, input) => !this.approvedUpfront(name, input),
			launchesSubagent: (name) => name === AGENT_TOOL,
			todoPlans: this.backend.todoPlans(),
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
			todoPlans: this.backend.todoPlans(),
			log,
		});
		const unsubscribe = pi.subscribe((event) => {
			transcript.handle(event);
			if (event.type === "tool_execution_start" && event.toolName === AGENT_TOOL) subagents.agentCallStarted(event.toolCallId, event.args);
			if (event.type === "tool_execution_end" && event.toolName === AGENT_TOOL) subagents.agentCallEnded(event.toolCallId, event.isError, signal.aborted);
			if (event.type === "tool_execution_end" && event.toolName === PLAN_COMPLETE_TOOL && !event.isError) planSubmitted = true;
			if (event.type === "message_end" && event.message.role === "assistant") {
				last = event.message as AssistantMessage;
				const u = last.usage;
				total.input += u.input;
				total.output += u.output;
				total.cacheRead += u.cacheRead;
				total.cacheWrite += u.cacheWrite;
				total.cost += u.cost.total;
				// The chat's cost from its transcript: earlier runs and processes, and Junie Cost's summaries, count too.
				const usage = this.usage(last);
				const costUsd = reportedCost(usage);
				if (costUsd !== this.meta.costUsd) {
					this.meta.costUsd = costUsd;
					this.persist(); // the session list shows it
				}
				sink({
					kind: "usage",
					inputTokens: u.input,
					outputTokens: u.output,
					contextUsed: u.input + u.cacheRead + u.cacheWrite + u.output,
					contextSize: model.contextWindow,
					costUsd: this.meta.costUsd, // cumulative for the chat, like Junie's usage_update
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
				if (this.backend.planModeAvailable()) await this.reviewNewPlan(pi, sink, signal, reviewPlan, planBefore, planSubmitted);
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
	 * Plan mode produced a plan in this turn (the plugin waits for a decision): shows it and asks the user, then
	 * implements it in the same turn, keeps planning (the user's next message revises it), or leaves plan mode.
	 * Without a review callback the plan is only shown; `/plan off` or a new message decides.
	 */
	private async reviewNewPlan(pi: AgentSession, sink: TurnSink, signal: AbortSignal, reviewPlan: PlanReviewAsk | undefined, before: string | undefined, submitted: boolean): Promise<void> {
		const plan = readPlanModeState(pi).awaitingPlan;
		if (!plan || signal.aborted || (plan === before && !submitted)) return;
		sink({ kind: "plan", plan: { kind: "markdown", id: REVIEW_PLAN_ID, content: plan } });
		if (!reviewPlan) return;
		const decision = await reviewPlan({ planId: REVIEW_PLAN_ID, markdown: plan }, signal);
		this.backend.log.info(`session ${this.id}: plan review -> ${decision}`);
		if (signal.aborted || decision === "revise") return;
		this.meta.planMode = false;
		this.persist();
		sink({ kind: "settings_changed" });
		await runPlanCommand(pi, decision === "implement" ? "/plan implement" : "/plan exit", decision === "implement" ? 2000 : 0);
		await this.drainSteering(pi, signal);
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

/** The command that switches plan mode (also the plugin's own command name). */
const PLAN_COMMAND = "plan";
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

/** Whether two descriptions of a model send requests the same way (address and headers). */
function sameRoute(a: Model<Api>, b: Model<Api>): boolean {
	return a.baseUrl === b.baseUrl && JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {});
}
