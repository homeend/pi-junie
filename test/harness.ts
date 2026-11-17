// Replay simulator: drives the real ACP driver with recorded AIR -> agent messages over an in-memory transport.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AcpAgent } from "../src/acp/agent.ts";
import type { JsonObject, Transport } from "../src/acp/jsonrpc.ts";
import type { Logger } from "../src/core/log.ts";
import type { AgentBackend, BackendSession, TurnSink } from "../src/core/ports.ts";
import type { ModelGroup, ModelRef, ProviderBinding, ProviderSlotState, TurnResult } from "../src/core/types.ts";

export interface Fixture {
	name: string;
	source: string;
	client: JsonObject[];
	reference: JsonObject[];
}

export function loadFixture(name: string): Fixture {
	return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8")) as Fixture;
}

/** Client side of an in-memory transport pair. */
export class MemoryWire {
	readonly sent: JsonObject[] = []; // agent -> client
	private agentListener?: (m: JsonObject) => void;
	private readonly waiters = new Map<unknown, (m: JsonObject) => void>();

	readonly agentTransport: Transport = {
		send: (m) => {
			const copy = structuredClone(m);
			this.sent.push(copy);
			if (copy.id !== undefined && copy.method === undefined) this.waiters.get(copy.id)?.(copy);
		},
		onMessage: (l) => {
			this.agentListener = l;
		},
		onClose: () => {},
	};

	/** Sends a client message; for requests resolves with the response. */
	async send(message: JsonObject, timeoutMs = 2000): Promise<JsonObject | undefined> {
		const isRequest = message.id !== undefined && typeof message.method === "string";
		const response = isRequest
			? new Promise<JsonObject>((resolve, reject) => {
					const t = setTimeout(() => reject(new Error(`no response to ${String(message.method)}#${String(message.id)}`)), timeoutMs);
					this.waiters.set(message.id, (m) => {
						clearTimeout(t);
						this.waiters.delete(message.id);
						resolve(m);
					});
				})
			: undefined;
		this.agentListener?.(structuredClone(message));
		return response;
	}

	notifications(method?: string): JsonObject[] {
		return this.sent.filter((m) => m.method !== undefined && (!method || m.method === method));
	}

	updates(kind?: string): JsonObject[] {
		return this.notifications("session/update")
			.map((m) => m.params as JsonObject)
			.filter((p) => !kind || (p.update as JsonObject).sessionUpdate === kind);
	}
}

/** Deterministic backend standing in for Pi. Records every call. */
export class FakeBackend implements AgentBackend {
	readonly calls: string[] = [];
	private readonly slots: ProviderSlotState[] = [
		{ id: "anthropic", displayName: "Anthropic", supportedApiTypes: ["anthropic"], required: false },
		{ id: "openai", displayName: "OpenAI", supportedApiTypes: ["openai"], required: false },
		{ id: "google", displayName: "Google", supportedApiTypes: ["google", "vertex"], required: false },
	];
	private readonly catalog: Record<string, string[]> = {
		anthropic: ["claude-opus-5-5", "claude-sonnet-5-5"],
		openai: ["gpt-6.1-sol"],
		google: ["gemini-3.7-flash"],
	};
	private readonly listeners = new Set<() => void>();
	private sessionCounter = 0;

	identity() {
		return { name: "pi-junie", title: "Pi (fake)", version: "0.0.0-test" };
	}
	providerSlots() {
		return this.slots;
	}
	bindProvider(b: ProviderBinding) {
		this.calls.push(`bind ${b.slotId} ${b.apiType}`);
		const slot = this.slots.find((s) => s.id === b.slotId);
		if (slot) slot.binding = b;
		this.emit();
	}
	unbindProvider(slotId: string) {
		this.calls.push(`unbind ${slotId}`);
		const slot = this.slots.find((s) => s.id === slotId);
		if (slot) slot.binding = undefined;
		this.emit();
	}
	availableModels(): ModelGroup[] {
		return this.slots
			.filter((s) => s.binding)
			.map((s) => ({ slotId: s.id, name: s.displayName, models: this.catalog[s.id].map((id) => ({ slotId: s.id, modelId: id, name: id })) }));
	}
	async modelsSettled() {}
	onModelsChanged(l: () => void) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	installedPlugins() {
		return [];
	}
	async openSession({ cwd }: { cwd: string }): Promise<BackendSession> {
		const id = `fake-session-${++this.sessionCounter}`;
		this.calls.push(`open ${id}`);
		let model: ModelRef | undefined;
		const calls = this.calls;
		return {
			id,
			cwd,
			currentModel: () => model,
			selectModel: async (ref) => {
				calls.push(`select ${ref.slotId}/${ref.modelId}`);
				model = ref;
			},
			prompt: async (text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> => {
				calls.push(`prompt ${id}: ${text}`);
				sink({ kind: "text", delta: "echo: " });
				await new Promise((r) => setTimeout(r, 5));
				if (signal.aborted) return { stop: "cancelled" };
				sink({ kind: "text", delta: text });
				sink({ kind: "usage", inputTokens: 10, outputTokens: 5, contextUsed: 15, contextSize: 1000 });
				return { stop: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
			},
			close: async () => {
				calls.push(`close ${id}`);
			},
		};
	}
	async resumeSession({ sessionId, cwd }: { sessionId: string; cwd: string }): Promise<BackendSession | undefined> {
		this.calls.push(`resume ${sessionId}`);
		return sessionId.startsWith("fake-session-") ? this.openSessionWithId(sessionId, cwd) : undefined;
	}
	private async openSessionWithId(id: string, cwd: string): Promise<BackendSession> {
		const s = await this.openSession({ cwd });
		return { ...s, id };
	}
	private emit() {
		for (const l of this.listeners) l();
	}
}

export interface ReplayResult {
	wire: MemoryWire;
	responses: Map<unknown, JsonObject>; // fixture request id -> our response
	requests: Map<unknown, JsonObject>;
}

/** Replays the fixture's client messages in order, remapping recorded session ids to ours. */
export interface ReplayOptions {
	logger?: Logger;
	/** Rewrites each client message before sending (e.g. point provider baseUrls at a local fake). */
	transform?: (message: JsonObject) => JsonObject;
	timeoutMs?: number;
}

export async function replay(fixture: Fixture, backend: AgentBackend, options: ReplayOptions = {}): Promise<ReplayResult> {

	const wire = new MemoryWire();
	new AcpAgent(wire.agentTransport, backend, { logger: options.logger });
	const responses = new Map<unknown, JsonObject>();
	const requests = new Map<unknown, JsonObject>();
	const sessionIdMap = new Map<string, string>();

	const remap = (value: unknown): unknown => {
		if (typeof value === "string") return sessionIdMap.get(value) ?? value;
		if (Array.isArray(value)) return value.map(remap);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
		return value;
	};

	for (const original of fixture.client) {
		const message = (options.transform ?? ((m) => m))(remap(original) as JsonObject);
		const response = await wire.send(message, options.timeoutMs);
		if (!response) continue;
		requests.set(message.id, message);
		responses.set(message.id, response);
		if (message.method === "session/new") {
			const recorded = fixture.reference.find((r) => r.id === message.id && r.result) as { result?: { sessionId?: string } } | undefined;
			const ours = (response.result as { sessionId?: string } | undefined)?.sessionId;
			if (recorded?.result?.sessionId && ours) sessionIdMap.set(recorded.result.sessionId, ours);
		}
	}
	return { wire, responses, requests };
}
