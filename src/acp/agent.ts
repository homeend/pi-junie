// ACP agent driver: dispatches ACP methods from the client (AIR) to an AgentBackend (core port).
// All ACP knowledge lives in src/acp; the backend only sees core types.

import { resolveFeatures } from "../compat/features.ts";
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

interface SessionEntry {
	backend: BackendSession;
	turn?: AbortController;
}

export interface AcpAgentOptions {
	log?: (line: string) => void;
}

export class AcpAgent {
	private readonly peer: JsonRpcPeer;
	private readonly backend: AgentBackend;
	private readonly log: (line: string) => void;
	private readonly sessions = new Map<string, SessionEntry>();
	private client?: ClientProfile;

	constructor(transport: Transport, backend: AgentBackend, options: AcpAgentOptions = {}) {
		this.backend = backend;
		this.log = options.log ?? (() => {});
		this.peer = new JsonRpcPeer(
			transport,
			(method, params) => this.handleRequest(method, params),
			(method, params) => this.handleNotification(method, params),
			this.log,
		);
		backend.onModelsChanged(() => this.broadcastConfigOptions());
	}

	get clientProfile(): ClientProfile | undefined {
		return this.client;
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
			this.sessions.get(String(params.sessionId))?.turn?.abort();
			return;
		}
		this.log(`ignored notification ${method}`);
	}

	private initialize(params: InitializeParams): InitializeResult {
		this.client = decodeClientProfile(params);
		const features = resolveFeatures(this.backend.installedPlugins(), this.client.features);
		for (const u of features.unavailable) this.log(`feature ${u.feature} unavailable: ${u.reason}`);
		const id = this.backend.identity();
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { audio: false, image: false, embeddedContext: true },
				mcpCapabilities: { http: false, sse: false },
				sessionCapabilities: { list: {}, close: {} },
				providers: {},
			},
			authMethods: [],
			agentInfo: { name: id.name, title: id.title, version: id.version },
			_meta: { jetbrains: { air: { version: 1, capabilities: features.advertised } } },
		};
	}

	private async newSession(params: JsonObject): Promise<unknown> {
		const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
		const backend = await this.backend.openSession({ cwd });
		this.sessions.set(backend.id, { backend });
		return { sessionId: backend.id, configOptions: this.configOptionsFor(backend) };
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
