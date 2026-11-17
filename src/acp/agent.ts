// ACP agent driver: dispatches ACP methods from the client (AIR) to an AgentBackend (core port).
// All ACP knowledge lives in src/acp; the backend only sees core types.
import { randomUUID } from "node:crypto";

import { resolveFeatures } from "../compat/features.ts";
import { type Logger, silentLogger } from "../core/log.ts";
import type { AgentBackend, BackendSession } from "../core/ports.ts";
import type { ClientProfile, PermissionDecision, PermissionRequest, PlanDecision, PlanReview, PromptInput, QuestionAnswers, QuestionForm, SubagentEvent, TurnEvent, TurnResult } from "../core/types.ts";
import {
	EFFORT_CONFIG_ID,
	MODEL_CONFIG_ID,
	decodeClientProfile,
	decodeModelValue,
	decodePrompt,
	decodeProviderBinding,
	decodeCommand,
	decodeListLimit,
	decodeMcpServers,
	decodeSkillRoots,
	encodeCommands,
	encodeConfigOptions,
	encodeHistory,
	encodePlan,
	encodePlanReview,
	encodePlanReviewDone,
	decodePlanDecision,
	decodeModeValue,
	MODE_CONFIG_ID,
	encodeSessionSummary,
	encodePromptResult,
	encodeProviderList,
	decodePermissionOutcome,
	encodePermissionRequest,
	encodeToolUpdate,
	encodeTurnEvent,
	BRAVE_CONFIG_ID,
	decodeBraveValue,
	MessageIds,
	standaloneMessage,
	encodeSessionFailure,
	encodeQuestionForm,
	decodeQuestionAnswers,
} from "./codec.ts";
import { type JsonObject, JsonRpcPeer, RpcError, type Transport } from "./jsonrpc.ts";
import { type InitializeParams, type InitializeResult, PROTOCOL_VERSION, type ProvidersSetParams, type SessionPromptParams, type SessionUpdate } from "./wire.ts";

const MODEL_DISCOVERY_WAIT_MS = 10_000;

/** Per-transcript stream state: tool calls already announced, message ids. */
interface TranscriptState {
	knownTools: Set<string>;
	messages: MessageIds;
}

/** AIR capability: subagents as child sessions. */
const NATIVE_SUBAGENT_SESSIONS = "nativeSubagentSessions";

interface SessionEntry {
	backend: BackendSession;
	turn?: AbortController;
	/** Settles when the running turn has released the session. */
	turnDone?: Promise<void>;
	/** Failed turns so far (ids of AIR failure rows). */
	failures?: number;
}

/** v1 steering: AIR sends a message typed while a turn runs (only when we advertise `_meta.steering.supported`). */
export const STEERING_METHOD = "_session/steering";
/** Top-level `_meta` key on the session/update that ends a turn AIR did not start with session/prompt. */
const LAST_REQUEST_COMPLETE = "lastRequestComplete";
const AUTH_STATUS_METHOD = "_auth/status_update";
/** What Junie reports when its models come from the IDE's proxy (`AcpLlmAccess`). */
const IDE_PROXY_AUTH_STATUS = { kind: "account", label: "JetBrains AI", detail: "IDE" };

export interface AcpAgentOptions {
	logger?: Logger;
}

export class AcpAgent {
	private readonly peer: JsonRpcPeer;
	private readonly backend: AgentBackend;
	private readonly log: Logger;
	private readonly sessions = new Map<string, SessionEntry>();
	private client?: ClientProfile;

	constructor(transport: Transport, backend: AgentBackend, options: AcpAgentOptions = {}) {
		this.backend = backend;
		this.log = options.logger ?? silentLogger;
		this.peer = new JsonRpcPeer(
			transport,
			(method, params) => this.traced(method, params),
			(method, params) => this.handleNotification(method, params),
			(line) => this.log.warn(line),
		);
		backend.onModelsChanged(() => this.broadcastConfigOptions());
	}

	get clientProfile(): ClientProfile | undefined {
		return this.client;
	}

	/** Logs one line per request: method, key params, outcome and duration. */
	private async traced(method: string, params: JsonObject): Promise<unknown> {
		const started = Date.now();
		const what = describeRequest(method, params);
		try {
			const result = await this.handleRequest(method, params);
			this.log.info(`${what} -> ok ${Date.now() - started}ms${describeResult(method, result)}`);
			return result;
		} catch (err) {
			this.log.error(`${what} -> FAILED ${Date.now() - started}ms: ${(err as Error).message}`);
			throw err;
		}
	}

	private async handleRequest(method: string, params: JsonObject): Promise<unknown> {
		switch (method) {
			case "initialize":
				return this.initialize(params as unknown as InitializeParams);
			case "providers/list":
				return encodeProviderList(this.backend.providerSlots());
			case "providers/set":
				this.backend.bindProvider(decodeProviderBinding(params as unknown as ProvidersSetParams, this.backend.providerSlots()));
				setTimeout(() => {
					for (const id of this.sessions.keys()) this.pushAuthStatus(id);
				});
				return {};
			case "providers/disable":
				this.backend.unbindProvider(String(params.providerId));
				return {};
			case "session/new":
				return this.newSession(params);
			case "session/resume":
				return this.resumeSession(params);
			case "session/set_config_option":
				return this.setConfigOption(params);
			case "session/prompt":
				return this.prompt(params as unknown as SessionPromptParams);
			case STEERING_METHOD:
				return this.steer(params as unknown as SessionPromptParams);
			case "session/list":
				return this.listSessions(params);
			case "session/load":
				return this.loadSession(params);
			case "session/close":
				return this.closeSession(String(params.sessionId));
			default:
				throw RpcError.methodNotFound(method);
		}
	}

	private handleNotification(method: string, params: JsonObject): void {
		if (method === "session/cancel") {
			const entry = this.sessions.get(String(params.sessionId));
			this.log.info(`session/cancel ${String(params.sessionId)}${entry?.turn ? "" : " (no running turn)"}`);
			entry?.turn?.abort();
			return;
		}
		this.log.warn(`ignored notification ${method}`);
	}

	private initialize(params: InitializeParams): InitializeResult {
		this.client = decodeClientProfile(params);
		const features = resolveFeatures(this.backend.installedPlugins(), this.client.features);
		this.log.info(
			`client ${this.client.name} ${this.client.version ?? ""} protocol=${params.protocolVersion} liveTerminal=${this.client.liveTerminal} air features=[${this.client.features.join(", ")}]`,
		);
		for (const u of features.unavailable) this.log.debug(`feature ${u.feature} unavailable: ${u.reason}`);
		const id = this.backend.identity();
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { audio: false, image: true, embeddedContext: true },
				mcpCapabilities: { http: true, sse: false },
				sessionCapabilities: { list: {}, close: {}, resume: {}, additionalDirectories: {} },
				providers: {},
				_meta: { authStatus: {} }, // we push _auth/status_update (Junie's capability marker)
			},
			authMethods: [],
			agentInfo: { name: id.name, title: id.title, version: id.version },
			_meta: { steering: { supported: true }, jetbrains: { air: { version: 1, capabilities: features.advertised } } },
		};
	}

	private async newSession(params: JsonObject): Promise<unknown> {
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		// Like Junie: give model discovery a moment so the first picker is complete; late results arrive as config_option_update.
		await this.backend.modelsSettled(MODEL_DISCOVERY_WAIT_MS);
		const backend = await this.backend.openSession(this.sessionContext(params, cwd));
		this.sessions.set(backend.id, { backend });
		this.publishCommands(backend);
		this.sendWelcome(backend.id);
		return { sessionId: backend.id, configOptions: this.configOptionsFor(backend) };
	}

	/** MCP servers and skill roots the client attaches to session/new, resume and load. */
	private sessionContext(params: JsonObject, cwd: string) {
		const { servers, skipped } = decodeMcpServers(params.mcpServers);
		const skillRoots = decodeSkillRoots(params, cwd);
		this.log.info(
			`session context: mcp [${servers.map((s) => `${s.name} (${s.transport})`).join(", ")}]${skipped.length ? ` skipped [${skipped.join(", ")}]` : ""} skill roots [${skillRoots.join(", ")}]`,
		);
		return {
			cwd,
			mcpServers: servers,
			skillRoots,
			questionForms: this.client?.questionForms === true,
			...(this.client ? { client: { name: this.client.name, ...(this.client.title ? { title: this.client.title } : {}) } } : {}),
		};
	}

	/**
	 * AIR's account label (`_auth/status_update`), pushed like Junie after session/new, resume and load, and when
	 * a provider is bound. Models go through AIR's own proxy, so Junie reports the IDE's JetBrains AI account
	 * (BYOK included). Nothing is pushed while no provider is bound.
	 */
	private pushAuthStatus(sessionId: string): void {
		if (!this.backend.providerSlots().some((s) => s.binding)) return;
		this.peer.notify(AUTH_STATUS_METHOD, { sessionId, authStatus: IDE_PROXY_AUTH_STATUS });
	}

	/** A new session opens with the backend's welcome message (agent, version, available plugins), after the response. */
	private sendWelcome(sessionId: string): void {
		const text = this.backend.welcome();
		if (!text) return;
		setTimeout(() => this.sendUpdate(sessionId, standaloneMessage(text)));
	}

	/** Sends the session's commands (built-ins, skills) and the auth label after the lifecycle response. */
	private publishCommands(session: BackendSession): void {
		setTimeout(() => {
			this.pushAuthStatus(session.id);
			session.commands().then(
				(commands) => this.sendUpdate(session.id, { sessionUpdate: "available_commands_update", availableCommands: encodeCommands(commands) }),
				(err: unknown) => this.log.warn(`session ${session.id}: command list failed: ${(err as Error).message}`),
			);
		});
	}

	private listSessions(params: JsonObject): unknown {
		const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
		const sessions = this.backend.listSessions({ cwd, limit: decodeListLimit(params) });
		return { sessions: sessions.map(encodeSessionSummary) };
	}

	/** Opens a saved session and replays its conversation as session/update notifications before answering. */
	private async loadSession(params: JsonObject): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		await this.backend.modelsSettled(MODEL_DISCOVERY_WAIT_MS);
		const existing = this.sessions.get(sessionId)?.backend;
		const resumed = existing ? { session: existing, restored: true } : await this.backend.resumeSession({ sessionId, ...this.sessionContext(params, cwd) });
		if (!resumed || !resumed.restored) throw new RpcError(-32002, `Session not found: ${sessionId}`);
		const backend = resumed.session;
		this.sessions.set(backend.id, { backend });
		this.publishCommands(backend);
		const history = backend.history();
		for (const update of encodeHistory(history, { planUpdates: this.client?.planUpdates })) this.sendUpdate(sessionId, update);
		const title = backend.title();
		if (title) this.sendUpdate(sessionId, { sessionUpdate: "session_info_update", title });
		// AIR writes the loaded history once it sees this marker (else when the load answers).
		if (this.client?.features.includes("loadReplayEnd")) {
			this.sendUpdate(sessionId, { sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { loadReplayEnd: true } } } });
		}
		this.log.info(`session/load ${sessionId}: replayed ${history.length} item(s)`);
		return { configOptions: this.configOptionsFor(backend) };
	}

	/** AIR resumes its chat after restarting the agent (e.g. when the LLM proxy identity changed). */
	private async resumeSession(params: JsonObject): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const existing = this.sessions.get(sessionId);
		if (existing) {
			setTimeout(() => this.pushAuthStatus(sessionId));
			return { configOptions: this.configOptionsFor(existing.backend) };
		}
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		await this.backend.modelsSettled(MODEL_DISCOVERY_WAIT_MS);
		const resumed = await this.backend.resumeSession({ sessionId, ...this.sessionContext(params, cwd) });
		if (!resumed) throw new RpcError(-32002, `Session not found: ${sessionId}`);
		const backend = resumed.session;
		this.sessions.set(backend.id, { backend });
		this.publishCommands(backend);
		if (!resumed.restored) {
			// After the response, tell the user the model will not see the earlier messages.
			setTimeout(() =>
				this.sendUpdate(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "_Pi could not restore the earlier messages of this chat, so it continues without them._\n\n" },
				}),
			);
		}
		return { configOptions: this.configOptionsFor(backend) };
	}

	private async setConfigOption(params: JsonObject): Promise<unknown> {
		const entry = this.requireSession(params.sessionId);
		if (params.configId === MODEL_CONFIG_ID) await entry.backend.selectModel(decodeModelValue(String(params.value)));
		else if (params.configId === EFFORT_CONFIG_ID) {
			const level = String(params.value);
			if (!entry.backend.effortLevels().includes(level)) throw RpcError.invalidParams(`Effort ${level} is not supported by the current model`);
			await entry.backend.selectEffort(level);
		} else if (params.configId === MODE_CONFIG_ID && entry.backend.planMode() !== undefined) {
			const plan = decodeModeValue(params.value);
			if (plan === undefined) throw RpcError.invalidParams(`Unknown mode: ${String(params.value)}`);
			await entry.backend.selectPlanMode(plan);
		} else if (params.configId === BRAVE_CONFIG_ID) {
			const mode = decodeBraveValue(params.value);
			if (!mode) throw RpcError.invalidParams(`Unknown Brave Mode value: ${String(params.value)}`);
			await entry.backend.selectApprovalMode(mode);
		} else throw RpcError.invalidParams(`Unknown config option: ${String(params.configId)}`);
		return { configOptions: this.configOptionsFor(entry.backend) };
	}

	private async prompt(params: SessionPromptParams): Promise<unknown> {
		const entry = this.requireSession(params.sessionId);
		if (entry.turn) throw new RpcError(-32000, "A prompt is already running in this session");
		return encodePromptResult(await this.runTurn(params.sessionId, entry, decodePrompt(params.prompt)));
	}

	/**
	 * `_session/steering`: a message typed while the agent works. Joins the running turn ("injected");
	 * if the turn has just ended, starts a new turn with it ("startedNewTurn") that we end ourselves with
	 * the lastRequestComplete carrier, since no session/prompt response will close it. Never dropped.
	 */
	private async steer(params: SessionPromptParams): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const entry = this.requireSession(sessionId);
		const input = decodePrompt(params.prompt);
		while (entry.turn) {
			const command = decodeCommand(input.text, await entry.backend.commands());
			if (command) input.command = command;
			const result = await entry.backend.steer(input);
			if (result === "injected") return { outcome: "injected" };
			if (result === "busy") {
				throw new RpcError(-32602, "The running turn cannot take this message now; send it when the turn ends", { reason: "steering_turn_busy" });
			}
			await entry.turnDone; // the turn is ending: wait until it releases the session
		}
		input.command = undefined;
		this.runTurn(sessionId, entry, input)
			.catch((err) => this.log.error(`session ${sessionId}: steered turn failed: ${(err as Error).message}`))
			.finally(() => this.peer.notify("session/update", {
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
				_meta: { [LAST_REQUEST_COMPLETE]: true },
			}));
		return { outcome: "startedNewTurn" };
	}

	/** Runs one turn on the backend, streaming its events as session/update. Owns `entry.turn` until it ends. */
	private runTurn(sessionId: string, entry: SessionEntry, input: PromptInput): Promise<TurnResult> {
		// The turn exists before any await, so a session/cancel arriving right away is not lost.
		const turn = new AbortController();
		entry.turn = turn;
		const stream: TranscriptState = { knownTools: new Set<string>(), messages: new MessageIds() };
		const knownTools = stream.knownTools;
		const children = new Map<string, TranscriptState>();
		const run = async (): Promise<TurnResult> => {
			try {
				const command = decodeCommand(input.text, await entry.backend.commands());
				if (command) {
					input.command = command;
					this.log.info(`session ${sessionId}: command ${command.name}${command.args ? ` (${command.args.length} chars of args)` : ""}`);
				}
				const result = await entry.backend.prompt(
					input,
					(event) => {
						// Native subagent sessions replace the launching tool's row (like Junie).
						if (event.kind === "tool" && event.update.launchesSubagent && this.nativeSubagents()) return;
						// The todo tool's calls show as the plan itself.
						if (event.kind === "tool" && event.update.presentsPlan) return;
						if (event.kind === "settings_changed") {
							this.sendUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions: this.configOptionsFor(entry.backend) });
							return;
						}
						if (event.kind === "subagent_spawned" || event.kind === "subagent_update" || event.kind === "subagent_finished") {
							this.relaySubagent(sessionId, event, children);
							return;
						}
						const update = this.encodeStreamed(event, stream);
						if (update) this.sendUpdate(sessionId, update);
					},
					turn.signal,
					(request) => {
						// A subagent's tool asks on the child session (AIR resolves it through the parent's request flow).
						const child = request.subagentId ? children.get(request.subagentId) : undefined;
						return child && request.subagentId
							? this.requestPermission(request.subagentId, request, child.knownTools, turn.signal)
							: this.requestPermission(sessionId, request, knownTools, turn.signal);
					},
					(form, signal) => this.askQuestions(sessionId, form, signal),
					(review, signal) => this.reviewPlan(sessionId, review, knownTools, signal),
				);
				if (result.stop === "error") this.reportFailure(sessionId, entry, result);
				return result;
			} finally {
				entry.turn = undefined;
			}
		};
		const done = run();
		entry.turnDone = done.then(
			() => undefined,
			() => undefined,
		);
		return done;
	}

	/**
	 * A failed turn: AIR's typed failure row (`sessionFailure`, one incident per turn like Junie) when the client
	 * opted in, else the error as message text.
	 */
	/** One streamed event of a transcript (the session's own or a subagent's) as an update; none for unknown kinds. */
	private encodeStreamed(event: TurnEvent, state: TranscriptState): SessionUpdate | undefined {
		if (event.kind === "tool") state.messages.break();
		const update =
			event.kind === "tool"
				? encodeToolUpdate(event.update, state.knownTools, { liveTerminal: this.client?.liveTerminal })
				: event.kind === "plan"
					? encodePlan(event.plan, this.client?.planUpdates === true)
					: encodeTurnEvent(event);
		if (update && (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")) {
			update.messageId = state.messages.next(event.kind === "thought" ? "thought" : "text", event.kind === "text" ? event.phase : undefined);
		}
		return update;
	}

	/**
	 * Subagents as AIR native child sessions (like Junie): `subagent_spawned` on the parent, the child's transcript
	 * on the child id, `subagent_state_update` on the parent. Clients without `nativeSubagentSessions` see only the
	 * parent's Agent tool row.
	 */
	private nativeSubagents(): boolean {
		return this.client?.features.includes(NATIVE_SUBAGENT_SESSIONS) === true;
	}

	private relaySubagent(sessionId: string, event: SubagentEvent, children: Map<string, TranscriptState>): void {
		if (!this.nativeSubagents()) return;
		switch (event.kind) {
			case "subagent_spawned":
				children.set(event.subagentId, { knownTools: new Set(), messages: new MessageIds() });
				this.sendUpdate(sessionId, {
					sessionUpdate: "subagent_spawned",
					subagentSessionId: event.subagentId,
					name: event.name,
					task: event.task,
					...(event.prompt ? { prompt: event.prompt } : {}),
					capabilities: { cancel: false, close: false },
				});
				return;
			case "subagent_update": {
				const child = children.get(event.subagentId);
				// The child's usage and title are its own business; the parent reports the turn's usage.
				if (!child || event.event.kind === "usage" || event.event.kind === "title") return;
				if (event.event.kind === "tool" && event.event.update.presentsPlan) return;
				const update = this.encodeStreamed(event.event, child);
				if (update) this.sendUpdate(event.subagentId, update);
				return;
			}
			case "subagent_finished":
				if (!children.has(event.subagentId)) return;
				this.sendUpdate(sessionId, { sessionUpdate: "subagent_state_update", subagentSessionId: event.subagentId, state: event.state });
				return;
		}
	}

	private reportFailure(sessionId: string, entry: SessionEntry, result: TurnResult): void {
		const failure = result.failure ?? { category: "unknown" as const, title: "The run stopped", details: result.error, actions: ["retry" as const] };
		if (this.client?.features.includes("sessionFailure")) {
			entry.failures = (entry.failures ?? 0) + 1;
			this.sendUpdate(sessionId, encodeSessionFailure(`turn-${entry.failures}:error`, failure));
		} else {
			this.sendUpdate(sessionId, standaloneMessage(`**Error:** ${result.error ?? failure.title}`));
		}
	}

	/** elicitation/create (form): the client shows the questions; a cancelled turn or tool cancels the form. */
	private async askQuestions(sessionId: string, form: QuestionForm, signal: AbortSignal): Promise<QuestionAnswers> {
		if (signal.aborted) return { action: "cancel" };
		const started = Date.now();
		const response = await Promise.race([
			this.peer.request("elicitation/create", encodeQuestionForm(sessionId, form)).catch((err: unknown) => {
				this.log.warn(`elicitation/create failed: ${(err as Error).message}`);
				return undefined;
			}),
			new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true })),
		]);
		const answers = decodeQuestionAnswers(form, response);
		this.log.info(`elicitation/create ${form.questions.length} question(s) -> ${answers.action} after ${Date.now() - started}ms`);
		return answers;
	}

	/** session/request_permission: the client shows the tool call with Allow once / Allow for this chat / Reject. */
	/** Plan review: Junie's permission request with the plan; the card is settled with the answer. */
	private async reviewPlan(sessionId: string, review: PlanReview, knownTools: Set<string>, signal: AbortSignal): Promise<PlanDecision> {
		if (signal.aborted) return "revise";
		const toolCallId = `plan-review:${randomUUID()}`;
		knownTools.add(toolCallId);
		const started = Date.now();
		const response = await Promise.race([
			this.peer.request<{ outcome?: { outcome?: string; optionId?: string } }>("session/request_permission", encodePlanReview(sessionId, toolCallId, review)),
			new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true })),
		]);
		const decision = decodePlanDecision(response);
		this.log.info(`plan review ${toolCallId} -> ${decision} after ${Date.now() - started}ms`);
		this.sendUpdate(sessionId, encodePlanReviewDone(toolCallId, decision));
		return decision;
	}

	private async requestPermission(sessionId: string, request: PermissionRequest, knownTools: Set<string>, signal: AbortSignal): Promise<PermissionDecision> {
		if (signal.aborted) return "reject";
		knownTools.add(request.toolCallId);
		const started = Date.now();
		const response = await Promise.race([
			this.peer.request<{ outcome?: { outcome?: string; optionId?: string } }>("session/request_permission", encodePermissionRequest(sessionId, request)),
			new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true })),
		]);
		const decision = decodePermissionOutcome(response);
		this.log.info(`session/request_permission ${request.toolName} ${request.toolCallId} -> ${decision} after ${Date.now() - started}ms`);
		return decision;
	}

	private async closeSession(sessionId: string): Promise<unknown> {
		const entry = this.sessions.get(sessionId);
		if (entry) {
			entry.turn?.abort();
			await entry.backend.close();
			this.sessions.delete(sessionId);
		}
		return {};
	}

	private configOptionsFor(session: BackendSession) {
		return encodeConfigOptions(
			this.backend.availableModels(),
			session.currentModel(),
			{ levels: session.effortLevels(), current: session.currentEffort() },
			session.approvalMode(),
			session.planMode(),
		);
	}

	private broadcastConfigOptions(): void {
		if (this.sessions.size) this.log.info(`models changed, config_option_update -> ${this.sessions.size} session(s)`);
		for (const [id, entry] of this.sessions) {
			this.sendUpdate(id, { sessionUpdate: "config_option_update", configOptions: this.configOptionsFor(entry.backend) });
		}
	}

	private sendUpdate(sessionId: string, update: SessionUpdate): void {
		this.peer.notify("session/update", { sessionId, update });
	}

	private requireSession(sessionId: unknown): SessionEntry {
		const entry = this.sessions.get(String(sessionId));
		if (!entry) throw new RpcError(-32002, `Session not found: ${String(sessionId)}`);
		return entry;
	}
}

function describeRequest(method: string, params: JsonObject): string {
	const parts = [method];
	if (params.sessionId) parts.push(`session=${String(params.sessionId)}`);
	if (params.providerId) parts.push(`provider=${String(params.providerId)}`);
	if (params.apiType) parts.push(`apiType=${String(params.apiType)}`);
	if (params.configId) parts.push(`${String(params.configId)}=${String(params.value)}`);
	if (method === "session/new" || method === "session/list") parts.push(`cwd=${String(params.cwd)}`);
	return parts.join(" ");
}

function describeResult(method: string, result: unknown): string {
	const r = result as Record<string, any> | undefined;
	if (method === "session/new") {
		const model = r?.configOptions?.find((o: { id: string }) => o.id === MODEL_CONFIG_ID);
		const count = model?.options?.reduce((n: number, g: { options: unknown[] }) => n + g.options.length, 0) ?? 0;
		return ` id=${r?.sessionId} models=${count} current=${model?.currentValue ?? "none"}`;
	}
	if (method === "session/prompt") return ` stop=${r?.stopReason}`;
	if (method === STEERING_METHOD) return ` outcome=${r?.outcome}`;
	if (method === "providers/list") return ` slots=${r?.providers?.map((p: { providerId: string; current: unknown }) => `${p.providerId}${p.current ? "*" : ""}`).join(",")}`;
	return "";
}
