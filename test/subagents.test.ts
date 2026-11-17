// Subagents end to end: a stand-in for @tintinweb/pi-subagents (an `Agent` tool running an in-process child Pi
// session, as the real plugin does) behind the full ACP driver, with a scripted fake model.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { SUBAGENTS_PLUGIN } from "../src/pi/plugins.ts";
import { type FakeRequest, LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

const transcript = (req: FakeRequest) =>
	req.body.messages.map((m: Obj) => (typeof m.content === "string" ? m.content : m.content.map((c: Obj) => c.text ?? "").join(""))).join("\n");
const hasToolResult = (req: FakeRequest) => req.body.messages.some((m: Obj) => Array.isArray(m.content) && m.content.some((c: Obj) => c.type === "tool_result"));

const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: (req) => {
		const text = transcript(req);
		const answered = hasToolResult(req);
		if (text.includes("investigate in parallel")) {
			return answered
				? "Both subagents reported."
				: {
						tool: "Agent",
						input: { prompt: "Find how the redis cache is used", description: "Redis cache", subagent_type: "Explore", run_in_background: true },
						also: [{ tool: "Agent", input: { prompt: "Describe how BYOK proxies work", description: "BYOK proxies", subagent_type: "Explore" } }],
					};
		}
		if (text.includes("redis cache")) return answered ? "Redis caches model listings." : { tool: "bash", input: { command: "touch redis.txt" } };
		if (text.includes("BYOK")) return answered ? "BYOK proxies forward the user's key." : { tool: "ls", input: { path: "." } };
		return "unexpected";
	},
});
afterAll(() => proxy.close());

/** Pi agent dir with a stand-in subagents plugin: `Agent` runs the prompt in a child Pi session on the parent's model. */
function piAgentDirWithSubagents(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	const pkg = join(agentDir, "npm", "node_modules", SUBAGENTS_PLUGIN);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: SUBAGENTS_PLUGIN, version: "0.26.0", pi: { extensions: ["./index.ts"] } }));
	writeFileSync(
		join(pkg, "index.ts"),
		`import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
		export default function (pi) {
			pi.registerTool({
				name: "Agent", label: "Agent", description: "Launch a subagent",
				parameters: { type: "object", properties: { prompt: { type: "string" }, description: { type: "string" }, subagent_type: { type: "string" }, run_in_background: { type: "boolean" } }, required: ["prompt"] },
				async execute(_id, params, _signal, onUpdate, ctx) {
					if (params.run_in_background !== false) return { content: [{ type: "text", text: "backgrounded" }], details: {} };
					const settingsManager = SettingsManager.inMemory({});
					const resourceLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: ${JSON.stringify(agentDir)}, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
					await resourceLoader.reload();
					const { session } = await createAgentSession({ cwd: ctx.cwd, model: ctx.model, modelRuntime: ctx.modelRegistry.runtime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(ctx.cwd), tools: ["bash", "ls"] });
					await session.bindExtensions({});
					for (let i = 0; i < 3; i++) onUpdate?.({ content: [{ type: "text", text: "working..." }], details: {} });
					await session.prompt(params.prompt);
					const last = session.messages.filter((m) => m.role === "assistant").at(-1);
					session.dispose();
					return { content: [{ type: "text", text: last.content.filter((c) => c.type === "text").map((c) => c.text).join("") }], details: {} };
				},
			});
		}`,
	);
	return agentDir;
}

async function airChat(capabilities: string[]) {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), piAgentDir: piAgentDirWithSubagents() });
	const wire = new MemoryWire();
	const asked: Obj[] = [];
	wire.clientHandler = (method, params) => {
		if (method === "session/request_permission") asked.push(params);
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	};
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	const init = await call("initialize", { protocolVersion: 1, clientInfo: { name: "air" }, clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities } } } } });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	const cwd = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
	const { result } = await call("session/new", { cwd, mcpServers: [] });
	const sessionId: string = result.sessionId;
	const prompt = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "investigate in parallel using 2 subagents" }] });
	const updates = wire.sent.filter((m) => m.method === "session/update").map((m) => m.params as Obj);
	return { init, sessionId, prompt, updates, asked };
}

describe("subagents", () => {
	it("shows each subagent as an AIR native child session, in parallel, asking for the child's tools", async () => {
		const { init, sessionId, prompt, updates, asked } = await airChat(["nativeSubagentSessions", "backgroundSubagents"]);
		expect(init.result._meta.jetbrains.air.capabilities).toContain("nativeSubagentSessions");
		expect(prompt.result.stopReason).toBe("end_turn");

		const onParent = updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
		const spawned = onParent.filter((u) => u.sessionUpdate === "subagent_spawned");
		expect(spawned.map((u) => [u.name, u.task, u.prompt, u.capabilities])).toEqual([
			["Explore", "Redis cache", "Find how the redis cache is used", { cancel: false, close: false }],
			["Explore", "BYOK proxies", "Describe how BYOK proxies work", { cancel: false, close: false }],
		]);
		const [redis, byok] = spawned.map((u) => u.subagentSessionId as string);
		expect(redis).not.toBe(byok);
		expect(onParent.filter((u) => u.sessionUpdate === "subagent_state_update").map((u) => [u.subagentSessionId, u.state]).sort()).toEqual(
			[[redis, "completed"], [byok, "completed"]].sort(),
		);
		// the child sessions replace the Agent tool rows
		expect(onParent.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")).toEqual([]);
		expect(onParent.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toBe("Both subagents reported.");

		// each child's transcript streams on its own session id
		const child = (id: string) => updates.filter((u) => u.sessionId === id).map((u) => u.update);
		expect(child(redis).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toBe("Redis caches model listings.");
		expect(child(redis).find((u) => u.sessionUpdate === "tool_call")).toMatchObject({ title: "Run touch redis.txt", kind: "execute" });
		expect(child(byok).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toBe("BYOK proxies forward the user's key.");
		expect(child(byok).at(-2)).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });

		// the model is told which models a subagent can run on
		const parentRequest = proxy.requests.find((r) => r.method === "POST" && transcript(r).includes("investigate in parallel"))!;
		const system = JSON.stringify(parentRequest.body.system);
		expect(system).toContain("## Subagent models");
		expect(system).toMatch(/claude-sonnet-5-5.*this session's model/);
		expect(system).toContain("claude-opus-5-5");

		// the child's bash asked for permission on the child session; ls (read-only) did not ask
		expect(asked.map((a) => [a.sessionId, a.toolCall.title])).toEqual([[redis, "Run touch redis.txt"]]);
	});

	it("without AIR's nativeSubagentSessions the client sees the Agent tool rows only", async () => {
		const { sessionId, updates } = await airChat([]);
		expect(updates.some((u) => u.update.sessionUpdate === "subagent_spawned")).toBe(false);
		expect(updates.every((u) => u.sessionId === sessionId)).toBe(true);
		const agentRows = updates.filter((u) => u.update.sessionUpdate === "tool_call").map((u) => u.update.title);
		expect(agentRows).toEqual(["Agent", "Agent"]);
	});
});
