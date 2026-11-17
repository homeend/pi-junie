// ACP agent driver: dispatches ACP methods from the client (AIR) to an AgentBackend (core port).
// All ACP knowledge lives in src/acp; the backend only sees core types.

import { resolveFeatures } from "../compat/features.ts";
import { type Logger, silentLogger } from "../core/log.ts";
import type { AgentBackend, BackendSession } from "../core/ports.ts";
import type { ClientProfile } from "../core/types.ts";
import {
	MODEL_CONFIG_ID,
	decodeClientProfile,
	decodeModelValue,
	decodePromptText,
	decodeProviderBinding,
	encodeConfigOptions,
	encodePromptResult,
	encodeProviderList,
	encodeTurnEvent,
} from "./codec.ts";
import { type JsonObject, JsonRpcPeer, RpcError, type Transport } from "./jsonrpc.ts";
import { type InitializeParams, type InitializeResult, PROTOCOL_VERSION, type ProvidersSetParams, type SessionPromptParams, type SessionUpdate } from "./wire.ts";

const MODEL_DISCOVERY_WAIT_MS = 10_000;

interface SessionEntry {
	backend: BackendSession;
	turn?: AbortController;
}

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
			case "session/list":
				// Sessions are in-memory and cannot be loaded back yet, so nothing is listed.
				return { sessions: [] };
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
		this.log.info(`client ${this.client.name} ${this.client.version ?? ""} protocol=${params.protocolVersion} air features=[${this.client.features.join(", ")}]`);
		for (const u of features.unavailable) this.log.debug(`feature ${u.feature} unavailable: ${u.reason}`);
		const id = this.backend.identity();
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { audio: false, image: false, embeddedContext: true },
				mcpCapabilities: { http: false, sse: false },
				sessionCapabilities: { list: {}, close: {}, resume: {} },
				providers: {},
			},
			authMethods: [],
			agentInfo: { name: id.name, title: id.title, version: id.version },
			_meta: { jetbrains: { air: { version: 1, capabilities: features.advertised } } },
		};
	}

	private async newSession(params: JsonObject): Promise<unknown> {
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		// Like Junie: give model discovery a moment so the first picker is complete; late results arrive as config_option_update.
		await this.backend.modelsSettled(MODEL_DISCOVERY_WAIT_MS);
		const backend = await this.backend.openSession({ cwd });
		this.sessions.set(backend.id, { backend });
		return { sessionId: backend.id, configOptions: this.configOptionsFor(backend) };
	}

	/** AIR resumes its chat after restarting the agent (e.g. when the LLM proxy identity changed). */
	private async resumeSession(params: JsonObject): Promise<unknown> {
		const sessionId = String(params.sessionId);
		const existing = this.sessions.get(sessionId);
		if (existing) return { configOptions: this.configOptionsFor(existing.backend) };
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		await this.backend.modelsSettled(MODEL_DISCOVERY_WAIT_MS);
		const backend = await this.backend.resumeSession({ sessionId, cwd });
		if (!backend) throw new RpcError(-32002, `Session not found: ${sessionId}`);
		this.sessions.set(backend.id, { backend });
		return { configOptions: this.configOptionsFor(backend) };
	}

	private async setConfigOption(params: JsonObject): Promise<unknown> {
		const entry = this.requireSession(params.sessionId);
		if (params.configId !== MODEL_CONFIG_ID) throw RpcError.invalidParams(`Unknown config option: ${String(params.configId)}`);
		await entry.backend.selectModel(decodeModelValue(String(params.value)));
		return { configOptions: this.configOptionsFor(entry.backend) };
	}

	private async prompt(params: SessionPromptParams): Promise<unknown> {
		const entry = this.requireSession(params.sessionId);
		if (entry.turn) throw new RpcError(-32000, "A prompt is already running in this session");
		const text = decodePromptText(params.prompt);
		const turn = new AbortController();
		entry.turn = turn;
		try {
			const result = await entry.backend.prompt(
				text,
				(event) => {
					const update = encodeTurnEvent(event);
					if (update) this.sendUpdate(params.sessionId, update);
				},
				turn.signal,
			);
			if (result.stop === "error") {
				this.sendUpdate(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n**Error:** ${result.error ?? "unknown error"}` } });
			}
			return encodePromptResult(result);
		} finally {
			entry.turn = undefined;
		}
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
		return encodeConfigOptions(this.backend.availableModels(), session.currentModel());
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
	if (method === "providers/list") return ` slots=${r?.providers?.map((p: { providerId: string; current: unknown }) => `${p.providerId}${p.current ? "*" : ""}`).join(",")}`;
	return "";
}
