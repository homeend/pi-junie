import { describe, expect, it } from "vitest";
import { FakeBackend, MemoryWire } from "./harness.ts";
import { AcpAgent } from "../src/acp/agent.ts";

type Obj = Record<string, any>;

async function connected() {
	const wire = new MemoryWire();
	const backend = new FakeBackend();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = async (method: string, params: Obj = {}) => (await wire.send({ jsonrpc: "2.0", id: ++id, method, params })) as Obj;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "air-plugin:idea" } });
	return { wire, backend, call };
}

describe("ACP driver", () => {
	it("returns no model option until a provider is bound, then pushes config_option_update", async () => {
		const { wire, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp", mcpServers: [] });
		expect(s.result.configOptions).toEqual([]);
		await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://proxy/openai", headers: {} });
		const [update] = wire.updates("config_option_update") as Obj[];
		expect(update.sessionId).toBe(s.result.sessionId);
		expect(update.update.configOptions[0].currentValue).toBe("pi:openai/gpt-6.1-sol");
	});

	it("switches models with session/set_config_option", async () => {
		const { backend, call } = await connected();
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: "http://proxy/a" });
		const s = await call("session/new", { cwd: "/tmp" });
		const res = await call("session/set_config_option", { sessionId: s.result.sessionId, configId: "model", value: "pi:anthropic/claude-sonnet-5-5" });
		expect(res.result.configOptions[0].currentValue).toBe("pi:anthropic/claude-sonnet-5-5");
		expect(backend.calls).toContain("select anthropic/claude-sonnet-5-5");
	});

	it("exposes an effort option for reasoning models and applies changes", async () => {
		const { backend, call } = await connected();
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: "http://proxy/a" });
		const s = await call("session/new", { cwd: "/tmp" });
		const sid = s.result.sessionId;
		await call("session/set_config_option", { sessionId: sid, configId: "model", value: "pi:anthropic/claude-opus-5-5" });
		const res = await call("session/set_config_option", { sessionId: sid, configId: "effort", value: "high" });
		const effort = res.result.configOptions.find((o: Obj) => o.id === "effort");
		expect(effort).toMatchObject({ category: "thought_level", currentValue: "high", _meta: { jetbrains: { air: { recommendedValue: "medium" } } } });
		expect(effort.options.map((o: Obj) => o.value)).toEqual(["low", "medium", "high"]);
		expect(backend.calls).toContain("effort high");
		expect((await call("session/set_config_option", { sessionId: sid, configId: "effort", value: "max" })).error.code).toBe(-32602);
	});

	it("rejects an apiType the slot does not support", async () => {
		const { call } = await connected();
		const res = await call("providers/set", { providerId: "anthropic", apiType: "openai", baseUrl: "http://x" });
		expect(res.error.code).toBe(-32602);
	});

	it("reads a vertex project/location from _meta.vertex (or _meta.claudeCode.vertex) like Junie", async () => {
		const { codec } = { codec: await import("../src/acp/codec.ts") };
		const slots = [{ id: "google", displayName: "Google", supportedApiTypes: ["google", "vertex"], required: false }];
		const bind = (_meta: unknown, apiType = "vertex") => codec.decodeProviderBinding({ providerId: "google", apiType, baseUrl: "http://p", _meta } as never, slots);
		expect(bind(undefined).vertex).toBeUndefined();
		expect(bind({ vertex: { projectId: "p1", location: "us-east5" } }).vertex).toEqual({ projectId: "p1", location: "us-east5" });
		expect(bind({ claudeCode: { vertex: { projectId: "p2", region: "europe-west4" } } }).vertex).toEqual({ projectId: "p2", location: "europe-west4" });
		expect(bind({ vertex: { projectId: "p1", location: "x" } }, "google").vertex).toBeUndefined();
		expect(() => bind({ vertex: { projectId: 1 } })).toThrow(/_meta.vertex/);
	});

	it("passes AIR's selectedModels to the backend and validates them", async () => {
		const { call } = await connected();
		const ok = await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://x", _meta: { jetbrains: { air: { selectedModels: ["gpt-6.1-sol"] } } } });
		expect(ok.result).toEqual({});
		const bad = await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://x", _meta: { jetbrains: { air: { selectedModels: "gpt" } } } });
		expect(bad.error.code).toBe(-32602);
	});

	it("session/cancel stops the running turn", async () => {
		const { wire, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp" });
		const pending = call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "hi" }] });
		await wire.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.result.sessionId } });
		expect((await pending).result.stopReason).toBe("cancelled");
	});

	it("session/resume reopens a saved session and fails for an unknown one", async () => {
		const { backend, call } = await connected();
		const res = await call("session/resume", { sessionId: "fake-session-7", cwd: "/tmp", mcpServers: [] });
		expect(res.result.configOptions).toEqual([]);
		expect(backend.calls).toContain("resume fake-session-7");
		const prompt = await call("session/prompt", { sessionId: "fake-session-7", prompt: [{ type: "text", text: "again" }] });
		expect(prompt.result.stopReason).toBe("end_turn");
		expect((await call("session/resume", { sessionId: "../x", cwd: "/tmp" })).error.code).toBe(-32002);
	});

	it("session/resume of an unknown chat continues it empty and tells the user", async () => {
		const { wire, call } = await connected();
		const res = await call("session/resume", { sessionId: "pi-old-1", cwd: "/tmp" });
		expect(res.result.configOptions).toEqual([]);
		await new Promise((r) => setTimeout(r, 5));
		const notice = wire.updates("agent_message_chunk").find((u: Obj) => u.sessionId === "pi-old-1") as Obj;
		expect(notice.update.content.text).toContain("could not restore");
		expect((await call("session/prompt", { sessionId: "pi-old-1", prompt: [{ type: "text", text: "hi" }] })).result.stopReason).toBe("end_turn");
	});

	it("advertises session resume", async () => {
		const wire = new MemoryWire();
		new AcpAgent(wire.agentTransport, new FakeBackend());
		const init = (await wire.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })) as Obj;
		expect(init.result.agentCapabilities.sessionCapabilities.resume).toEqual({});
	});

	it("accepts image prompts (advertised) and passes them to the backend", async () => {
		const { backend, call } = await connected();
		const init = (await call("initialize", { protocolVersion: 1 })).result;
		expect(init.agentCapabilities.promptCapabilities.image).toBe(true);
		const s = await call("session/new", { cwd: "/tmp" });
		const res = await call("session/prompt", {
			sessionId: s.result.sessionId,
			prompt: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
		expect(res.result.stopReason).toBe("end_turn");
		expect(backend.calls).toContain(`prompt ${s.result.sessionId}: what is this? +1 image(s)`);
	});

	it("session/list returns saved sessions with AIR metadata, honouring AIR's limit", async () => {
		const { backend, call } = await connected();
		const res = await call("session/list", { cwd: "/tmp", _meta: { jetbrains: { air: { version: 1, list: { limit: 500 } } } } });
		expect(res.result.sessions).toEqual([
			{ sessionId: "fake-session-old", cwd: "/tmp", title: "Old chat", updatedAt: "2026-11-01T10:05:00Z", _meta: { jetbrains: { air: { version: 1, archived: false, state: "idle", lastPromptAt: "2026-11-01T10:04:00Z" } } } },
		]);
		expect(backend.calls).toContain("list /tmp 200");
	});

	it("session/load replays the conversation before answering, and fails for unknown sessions", async () => {
		const { wire, call } = await connected();
		const before = wire.sent.length;
		const res = await call("session/load", { sessionId: "fake-session-old", cwd: "/tmp", mcpServers: [] });
		const sent = wire.sent.slice(before);
		const responseIndex = sent.findIndex((m) => m.id !== undefined);
		const replay = sent.slice(0, responseIndex).map((m: Obj) => [m.params.update.sessionUpdate, m.params.update.content?.text ?? m.params.update.title]);
		expect(replay).toEqual([
			["user_message_chunk", "earlier question"],
			["agent_thought_chunk", "hmm"],
			["agent_message_chunk", "earlier answer"],
			["session_info_update", "Old chat"],
		]);
		expect(res.result.configOptions).toBeDefined();
		expect((await call("session/load", { sessionId: "pi-unknown", cwd: "/tmp" })).error.code).toBe(-32002);
	});

	it("replays tool calls as complete tool_call updates", async () => {
		const { encodeHistory } = await import("../src/acp/codec.ts");
		const updates = encodeHistory([
			{ kind: "user", text: "q", imageCount: 0 },
			{ kind: "tool", update: { id: "t1", name: "read", title: "Read a.txt", toolKind: "read", status: "completed", input: { path: "a.txt" }, output: "alpha" } },
		]) as Obj[];
		expect(updates[1]).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "Read a.txt",
			kind: "read",
			status: "completed",
			rawInput: { path: "a.txt" },
			content: [{ type: "content", content: { type: "text", text: "alpha" } }],
		});
	});

	it("encodes terminal tools with AIR's v1 terminal envelope only for clients that asked for it", async () => {
		const { encodeToolUpdate } = await import("../src/acp/codec.ts");
		const live = new Set<string>();
		const start = encodeToolUpdate({ id: "b1", name: "bash", title: "Run ls", toolKind: "execute", status: "pending", input: { command: "ls" }, terminal: { command: "ls", cwd: "/p" } }, live, { liveTerminal: true }) as Obj;
		expect(start).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "b1", kind: "execute", rawInput: { command: "ls", cwd: "/p" }, content: [{ type: "terminal", terminalId: "b1" }] });
		const chunk = encodeToolUpdate({ id: "b1", name: "bash", status: "in_progress", output: "a\n", terminal: { command: "", cwd: "/p", delta: "a\n" } }, live, { liveTerminal: true }) as Obj;
		expect(chunk).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "in_progress", _meta: { terminal_output_delta: { data: "a\n", terminal_id: "b1" } } });
		const end = encodeToolUpdate({ id: "b1", name: "bash", status: "completed", output: "a\n", terminal: { command: "", cwd: "/p", exitCode: 0 } }, live, { liveTerminal: true }) as Obj;
		expect(end._meta).toEqual({ terminal_exit: { exit_code: 0, signal: null, terminal_id: "b1" } });
		expect(end.rawOutput).toEqual({ output: "a\n", exitCode: 0 });

		const plain = encodeToolUpdate({ id: "b2", name: "bash", status: "completed", output: "a\n", terminal: { command: "ls", cwd: "/p", exitCode: 0 } }, new Set(), { liveTerminal: false }) as Obj;
		expect(plain.content).toEqual([{ type: "content", content: { type: "text", text: "a\n" } }]);
		expect(plain._meta).toBeUndefined();
	});

	it("detects AIR's live terminal opt-in from its initialize message", async () => {
		const { decodeClientProfile } = await import("../src/acp/codec.ts");
		const { loadFixture } = await import("./harness.ts");
		const init = loadFixture("junie-hello").client.find((m) => m.method === "initialize") as Obj;
		expect(decodeClientProfile(init.params).liveTerminal).toBe(true);
		expect(decodeClientProfile({ protocolVersion: 1 }).liveTerminal).toBe(false);
	});

	it("passes the client's MCP servers (AIR's IDE server) to the backend and advertises HTTP MCP", async () => {
		const { backend, call } = await connected();
		const { loadFixture } = await import("./harness.ts");
		const recorded = loadFixture("junie-hello").client.find((m) => m.method === "session/new") as Obj;
		await call("session/new", {
			...recorded.params,
			mcpServers: [...recorded.params.mcpServers, { type: "http", name: "air private", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] }, { type: "sse", name: "old", url: "http://x" }],
		});
		expect(backend.mcp.map((m) => [m.name, m.transport])).toEqual([
			["jetbrains_air_ide", "stdio"],
			["air private", "http"],
		]);
		const ide = backend.mcp[0] as Extract<(typeof backend.mcp)[number], { transport: "stdio" }>;
		expect(ide.args).toEqual(["stdioMcpServer"]);
		expect(ide.env.IJ_MCP_LAUNCH_ORIGIN).toBe("air-chat");
		expect(backend.mcp[1]).toMatchObject({ headers: { Authorization: "Bearer x" } });
		expect((await call("initialize", { protocolVersion: 1 })).result.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });
	});

	it("passes AIR's skill roots (standard field first, else _meta.additionalRoots) and advertises additionalDirectories", async () => {
		const { backend, call } = await connected();
		const { loadFixture } = await import("./harness.ts");
		const recorded = loadFixture("junie-hello").client.find((m) => m.method === "session/new") as Obj;
		await call("session/new", recorded.params);
		expect(backend.skillRoots).toEqual(recorded.params._meta.additionalRoots);
		await call("session/new", { cwd: "/p", additionalDirectories: ["/skills/a", "relative", "/p", "/skills/a"], _meta: { additionalRoots: ["/ignored"] } });
		expect(backend.skillRoots.slice(-1)).toEqual(["/skills/a"]);
		const init = (await call("initialize", { protocolVersion: 1 })).result;
		expect(init.agentCapabilities.sessionCapabilities.additionalDirectories).toEqual({});
	});

	it("publishes the session's commands for AIR's popup after session/new", async () => {
		const { wire, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp" });
		await new Promise((r) => setTimeout(r, 5));
		const [update] = wire.updates("available_commands_update") as Obj[];
		expect(update.sessionId).toBe(s.result.sessionId);
		expect(update.update.availableCommands).toEqual([
			{ name: "new", description: "Open a new empty chat", _meta: { jetbrains: { air: { commandAction: { kind: "openNewSession" } } } } },
			{ name: "compact", description: "Summarize", input: { type: "unstructured", hint: "optional instructions" } },
			{
				name: "$release-notes",
				description: "Write release notes",
				input: { type: "unstructured", hint: "optional task" },
				_meta: { jetbrains: { air: { version: 1, kind: "skill", skillPath: "/skills/release-notes/SKILL.md" } } },
			},
		]);
	});

	it("recognises invoked commands in the prompt text", async () => {
		const { backend, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp" });
		const send = (text: string) => call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text }] });
		await send("/compact keep the decisions");
		await send("$release-notes for 1.2");
		await send("/release-notes");
		await send("/unknown thing");
		await send("$compact");
		const prompts = backend.calls.filter((c) => c.startsWith("prompt"));
		expect(prompts.map((c) => c.split(": ").slice(1).join(": "))).toEqual([
			"/compact keep the decisions [command compact: keep the decisions]",
			"$release-notes for 1.2 [command release-notes: for 1.2]",
			"/release-notes [command release-notes: ]",
			"/unknown thing",
			"$compact",
		]);
	});

	describe("steering (typing while the agent works)", () => {
		const tick = () => new Promise((r) => setTimeout(r, 5));
		const text = (t: string) => [{ type: "text", text: t }];

		it("advertises v1 steering like Junie", async () => {
			const { call } = await connected();
			expect((await call("initialize", { protocolVersion: 1 })).result._meta.steering).toEqual({ supported: true });
		});

		it("injects a message into the running turn; the turn's own response still ends it", async () => {
			const { backend, call } = await connected();
			const s = await call("session/new", { cwd: "/tmp" });
			const sessionId = s.result.sessionId;
			const pending = call("session/prompt", { sessionId, prompt: text("slow task") });
			await tick();
			const steer = await call("_session/steering", { sessionId, prompt: text("also check the tests") });
			expect(steer.result).toEqual({ outcome: "injected" });
			const skill = await call("_session/steering", { sessionId, prompt: text("$release-notes for 1.2") });
			expect(skill.result).toEqual({ outcome: "injected" });
			backend.release();
			expect((await pending).result.stopReason).toBe("end_turn");
			expect(backend.calls.filter((c) => /^(prompt|steer)/.test(c))).toEqual([
				`prompt ${sessionId}: slow task`,
				`steer ${sessionId}: also check the tests`,
				`steer ${sessionId}: $release-notes for 1.2 [command release-notes: for 1.2]`,
			]);
		});

		it("starts a new turn when nothing runs, and ends it with Junie's lastRequestComplete carrier", async () => {
			const { wire, backend, call } = await connected();
			const s = await call("session/new", { cwd: "/tmp" });
			const sessionId = s.result.sessionId;
			const steer = await call("_session/steering", { sessionId, prompt: text("slow late follow-up") });
			expect(steer.result).toEqual({ outcome: "startedNewTurn" });
			// the new turn holds the session: ordinary prompts wait, steering joins it
			const busy = await call("session/prompt", { sessionId, prompt: text("another") });
			expect(busy.error.code).toBe(-32000);
			expect((await call("_session/steering", { sessionId, prompt: text("and this") })).result).toEqual({ outcome: "injected" });
			expect(wire.notifications("session/update").some((n) => (n.params as Obj)._meta)).toBe(false);
			backend.release();
			for (let i = 0; i < 50 && !wire.notifications("session/update").some((n) => (n.params as Obj)._meta); i++) await tick();
			const last = wire.notifications("session/update").at(-1)!.params as Obj;
			expect(last).toEqual({
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
				_meta: { lastRequestComplete: true },
			});
			expect(wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("")).toContain("echo: slow late follow-up");
		});

		it("refuses commands that need their own turn, and anything while a command runs", async () => {
			const { backend, call } = await connected();
			const s = await call("session/new", { cwd: "/tmp" });
			const sessionId = s.result.sessionId;
			const pending = call("session/prompt", { sessionId, prompt: text("slow task") });
			await tick();
			const compact = await call("_session/steering", { sessionId, prompt: text("/compact") });
			expect(compact.error).toMatchObject({ code: -32602, data: { reason: "steering_turn_busy" } });
			backend.release();
			await pending;

			const compacting = call("session/prompt", { sessionId, prompt: text("/compact slowly") });
			await tick();
			const during = await call("_session/steering", { sessionId, prompt: text("hello") });
			expect(during.error).toMatchObject({ code: -32602, data: { reason: "steering_turn_busy" } });
			backend.release();
			expect((await compacting).result.stopReason).toBe("end_turn");
		});

		it("an unknown session is session_not_loaded (-32002)", async () => {
			const { call } = await connected();
			expect((await call("_session/steering", { sessionId: "nope", prompt: text("hi") })).error.code).toBe(-32002);
		});
	});

	it("advertises loadSession", async () => {
		const { call } = await connected();
		expect((await call("initialize", { protocolVersion: 1 })).result.agentCapabilities.loadSession).toBe(true);
	});

	it("asks the client before a tool runs and streams the tool call", async () => {
		const { wire, call } = await connected();
		const asked: Obj[] = [];
		wire.clientHandler = (method, params) => {
			asked.push({ method, params });
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		};
		const s = await call("session/new", { cwd: "/tmp" });
		const res = await call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "run ls -la" }] });
		expect(res.result.stopReason).toBe("end_turn");
		expect(asked).toHaveLength(1);
		expect(asked[0].method).toBe("session/request_permission");
		expect(asked[0].params.toolCall).toMatchObject({ toolCallId: "tool-1", title: "Run ls -la", kind: "execute", rawInput: { command: "ls -la" } });
		expect(asked[0].params.options.map((o: Obj) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
		const tools = wire.updates().map((u: Obj) => u.update).filter((u: Obj) => u.sessionUpdate.startsWith("tool_call"));
		expect(tools.map((u: Obj) => [u.sessionUpdate, u.status])).toEqual([
			["tool_call", "pending"],
			["tool_call_update", "in_progress"],
			["tool_call_update", "completed"],
		]);
		expect(tools[2].content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
	});

	it("a rejected or cancelled permission blocks the tool", async () => {
		const { wire, backend, call } = await connected();
		wire.clientHandler = () => ({ outcome: { outcome: "cancelled" } });
		const s = await call("session/new", { cwd: "/tmp" });
		await call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "run make deploy" }] });
		expect(backend.calls).toContain("permission reject");
		const last = wire.updates("tool_call_update").at(-1) as Obj;
		expect(last.update.status).toBe("failed");
	});

	it("unknown methods get -32601", async () => {
		const { call } = await connected();
		expect((await call("_session/goal")).error.code).toBe(-32601);
	});
});
