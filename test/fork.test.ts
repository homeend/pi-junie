// session/fork (Junie's v1 shape, AIR's "Open in New Session"): a new session with the conversation so far, in the
// request's cwd (the current project or a worktree AIR just made).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

const userTexts = (body: Obj) =>
	body.messages
		.filter((m: Obj) => m.role === "user")
		.map((m: Obj) => (typeof m.content === "string" ? m.content : m.content.map((c: Obj) => c.text ?? "").join("")));

const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: (req) => `Reply ${userTexts(req.body).length}.`,
});
afterAll(() => proxy.close());

const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));

async function connect() {
	const backend = await PiBackend.create({ stateDir });
	const wire = new MemoryWire();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	const init = await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(5000);
	const updates = (sessionId: string) =>
		wire.sent.filter((m) => m.method === "session/update" && (m.params as Obj).sessionId === sessionId).map((m) => (m.params as Obj).update);
	return { call, updates, init };
}

describe("session/fork", () => {
	it("copies the conversation and the settings into a new session in the requested cwd, which loads and continues there", async () => {
		const first = await connect();
		expect(first.init.result.agentCapabilities.sessionCapabilities.fork).toEqual({});
		const project = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
		const worktree = mkdtempSync(join(tmpdir(), "pi-junie-wt-"));
		const { result } = await first.call("session/new", { cwd: project, mcpServers: [] });
		const source = result.sessionId;
		await first.call("session/set_config_option", { sessionId: source, configId: "effort", value: "low" });
		await first.call("session/set_config_option", { sessionId: source, configId: "brave_mode", value: "on" });
		await first.call("session/prompt", { sessionId: source, prompt: [{ type: "text", text: "first question" }] });

		const fork = await first.call("session/fork", { sessionId: source, cwd: worktree, mcpServers: [] });
		const forkId = fork.result.sessionId;
		expect(forkId).not.toBe(source);
		const option = (id: string) => fork.result.configOptions.find((o: Obj) => o.id === id).currentValue;
		expect([option("effort"), option("brave_mode")]).toEqual(["low", "on"]);

		// listed under the worktree, with its parent
		const listed = (await first.call("session/list", { cwd: worktree })).result.sessions;
		expect(listed).toEqual([expect.objectContaining({ sessionId: forkId, cwd: worktree, _meta: { jetbrains: { air: expect.objectContaining({ forkedFrom: source }) } } })]);
		expect((await first.call("session/list", { cwd: project })).result.sessions.map((s: Obj) => s.sessionId)).toEqual([source]);

		// the fork is live at once: the model sees the copied conversation
		await first.call("session/prompt", { sessionId: forkId, prompt: [{ type: "text", text: "in the fork" }] });
		expect(userTexts(proxy.requests.at(-1)!.body)).toEqual(["first question", "in the fork"]);

		// a new agent process loads it from the worktree, with the copied and the new turns
		const second = await connect();
		await second.call("session/load", { sessionId: forkId, cwd: worktree, mcpServers: [] });
		const replayed = second.updates(forkId).filter((u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk");
		expect(replayed.map((u) => [u.sessionUpdate, u.content.text])).toEqual([
			["user_message_chunk", "first question"],
			["agent_message_chunk", "Reply 1."],
			["user_message_chunk", "in the fork"],
			["agent_message_chunk", "Reply 2."],
		]);

		// the source is untouched
		await second.call("session/load", { sessionId: source, cwd: project, mcpServers: [] });
		expect(second.updates(source).filter((u) => u.sessionUpdate === "user_message_chunk").map((u) => u.content.text)).toEqual(["first question"]);
	});

	it("rejects an unknown session and a request without cwd", async () => {
		const { call } = await connect();
		expect((await call("session/fork", { sessionId: "pi-nope", cwd: tmpdir(), mcpServers: [] })).error.code).toBe(-32002);
		expect((await call("session/fork", { sessionId: "pi-nope", mcpServers: [] })).error.code).toBe(-32602);
	});
});
