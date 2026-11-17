// ACP agent driver: dispatches ACP methods from the client (AIR) to an AgentBackend (core port).
// All ACP knowledge lives in src/acp; the backend only sees core types.

import { resolveFeatures } from "../compat/features.ts";
import { type Logger, silentLogger } from "../core/log.ts";
import type { AgentBackend, BackendSession } from "../core/ports.ts";
import type { ClientProfile, PermissionDecision, PermissionRequest, PromptInput, TurnResult } from "../core/types.ts";
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
	encodeSessionSummary,
	encodePromptResult,
	encodeProviderList,
	decodePermissionOutcome,
	encodePermissionRequest,
	encodeToolUpdate,
	encodeTurnEvent,
} from "./codec.ts";
import { type JsonObject, JsonRpcPeer, RpcError, type Transport } from "./jsonrpc.ts";
import { type InitializeParams, type InitializeResult, PROTOCOL_VERSION, type ProvidersSetParams, type SessionPromptParams, type SessionUpdate } from "./wire.ts";

const MODEL_DISCOVERY_WAIT_MS = 10_000;

interface SessionEntry {
	backend: BackendSession;
	turn?: AbortController;
	/** Settles when the running turn has released the session. */
	turnDone?: Promise<void>;
}

/** v1 steering: AIR sends a message typed while a turn runs (only when we advertise `_meta.steering.supported`). */
export const STEERING_METHOD = "_session/steering";
/** Top-level `_meta` key on the session/update that ends a turn AIR did not start with session/prompt. */
const LAST_REQUEST_COMPLETE = "lastRequestComplete";

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
		return { sessionId: backend.id, configOptions: this.configOptionsFor(backend) };
	}

	/** MCP servers and skill roots the client attaches to session/new, resume and load. */
	private sessionContext(params: JsonObject, cwd: string) {
		const { servers, skipped } = decodeMcpServers(params.mcpServers);
		const skillRoots = decodeSkillRoots(params, cwd);
		this.log.info(
			`session context: mcp [${servers.map((s) => `${s.name} (${s.transport})`).join(", ")}]${skipped.length ? ` skipped [${skipped.join(", ")}]` : ""} skill roots [${skillRoots.join(", ")}]`,
		);
		return { cwd, mcpServers: servers, skillRoots };
	}

	/** Sends the session's commands (built-ins, skills) after the lifecycle response. */
	private publishCommands(session: BackendSession): void {
		setTimeout(() => {
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
		for (const update of encodeHistory(history)) this.sendUpdate(sessionId, update);
		const title = backend.title();
		if (title) this.sendUpdate(sessionId, { sessionUpdate: "session_info_update", title });
		this.log.info(`session/load ${sessionId}: replayed ${history.length} item(s)`);
		return { configOptions: this.configOptionsFor(backend) };
	}

	/** AIR resumes its chat after restarting the agent (e.g. when the LLM proxy identity changed). */
	private async resumeSession(params: JsonObject): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const existing = this.sessions.get(sessionId);
		if (existing) return { configOptions: this.configOptionsFor(existing.backend) };
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
		const knownTools = new Set<string>();
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
						const update =
							event.kind === "tool" ? encodeToolUpdate(event.update, knownTools, { liveTerminal: this.client?.liveTerminal }) : encodeTurnEvent(event);
						if (update) this.sendUpdate(sessionId, update);
					},
					turn.signal,
					(request) => this.requestPermission(sessionId, request, knownTools, turn.signal),
				);
				if (result.stop === "error") {
					this.sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n**Error:** ${result.error ?? "unknown error"}` } });
				}
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

	/** session/request_permission: the client shows the tool call with Allow once / Allow for this chat / Reject. */
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
		return encodeConfigOptions(this.backend.availableModels(), session.currentModel(), {
			levels: session.effortLevels(),
			current: session.currentEffort(),
		});
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
