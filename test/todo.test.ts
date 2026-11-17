// The todo plugin (@juicesharp/rpiv-todo): its `todo` calls reach the client as the plan, not as tool rows.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { TODO_PLUGIN } from "../src/pi/plugins.ts";
import { type FakeRequest, LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

const toolResults = (req: FakeRequest) =>
	req.body.messages.flatMap((m: Obj) => (Array.isArray(m.content) ? m.content.filter((c: Obj) => c.type === "tool_result") : [])).length;

const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: (req) => {
		switch (toolResults(req)) {
			case 0:
				return { tool: "todo", input: { action: "create", tasks: [{ subject: "Read the code" }, { subject: "Fix the bug" }, { subject: "Drop me" }] } };
			case 1:
				return { tool: "todo", input: { action: "update", id: 1, status: "in_progress" } };
			case 2:
				return { tool: "todo", input: { action: "delete", id: 3 } };
			default:
				return "Planned.";
		}
	},
});
afterAll(() => proxy.close());

/** Pi agent dir with a stand-in todo plugin: `todo` keeps a list and returns it whole in `details.tasks`, like rpiv-todo. */
function piAgentDirWithTodo(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	const pkg = join(agentDir, "npm", "node_modules", TODO_PLUGIN);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: TODO_PLUGIN, version: "2.15.0", pi: { extensions: ["./index.ts"] } }));
	writeFileSync(
		join(pkg, "index.ts"),
		`export default function (pi) {
			let tasks = [];
			pi.registerTool({
				name: "todo", label: "Todo", description: "Manage the todo list",
				parameters: { type: "object", properties: { action: { type: "string" }, tasks: { type: "array" }, id: { type: "number" }, status: { type: "string" } }, required: ["action"] },
				async execute(_id, p) {
					if (p.action === "create") tasks = [...tasks, ...p.tasks.map((t, i) => ({ id: tasks.length + i + 1, subject: t.subject, status: "pending" }))];
					if (p.action === "update") tasks = tasks.map((t) => (t.id === p.id ? { ...t, status: p.status } : t));
					if (p.action === "delete") tasks = tasks.map((t) => (t.id === p.id ? { ...t, status: "deleted" } : t));
					return { content: [{ type: "text", text: "ok" }], details: { action: p.action, params: p, tasks, nextId: tasks.length + 1 } };
				},
			});
		}`,
	);
	return agentDir;
}

async function chat(clientCapabilities: Obj) {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
	const piAgentDir = piAgentDirWithTodo();
	const connect = async () => {
		const backend = await PiBackend.create({ stateDir, piAgentDir });
		const wire = new MemoryWire();
		const asked: Obj[] = [];
		wire.clientHandler = (method, params) => {
			if (method === "session/request_permission") asked.push(params);
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		};
		new AcpAgent(wire.agentTransport, backend);
		let id = 0;
		const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
		await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities });
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		const updates = () => wire.sent.filter((m) => m.method === "session/update").map((m) => (m.params as Obj).update);
		return { call, updates, asked };
	};
	const first = await connect();
	const cwd = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
	const { result } = await first.call("session/new", { cwd, mcpServers: [] });
	await first.call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "plan the work" }] });
	const reopened = await connect();
	await reopened.call("session/load", { sessionId: result.sessionId, cwd, mcpServers: [] });
	return { live: first.updates(), asked: first.asked, replay: reopened.updates() };
}

const items = (entries: [string, string][]) => entries.map(([content, status]) => ({ content, status, priority: "medium" }));

describe("todo list as the plan", () => {
	it("a client with plan updates gets the list as plan `main`, without todo rows or permission prompts", async () => {
		const { live, asked, replay } = await chat({ plan: {} });
		const plans = live.filter((u) => u.sessionUpdate === "plan_update" || u.sessionUpdate === "plan_removed" || u.sessionUpdate === "plan");
		expect(plans).toEqual([
			{ sessionUpdate: "plan_update", plan: { type: "items", id: "main", entries: items([["Read the code", "pending"], ["Fix the bug", "pending"], ["Drop me", "pending"]]) } },
			{ sessionUpdate: "plan_update", plan: { type: "items", id: "main", entries: items([["Read the code", "in_progress"], ["Fix the bug", "pending"], ["Drop me", "pending"]]) } },
			{ sessionUpdate: "plan_update", plan: { type: "items", id: "main", entries: items([["Read the code", "in_progress"], ["Fix the bug", "pending"]]) } },
		]);
		expect(live.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")).toEqual([]);
		expect(asked).toEqual([]);
		// reopening the chat shows the list as it was last, still without the rows
		expect(replay.filter((u) => u.sessionUpdate === "tool_call")).toEqual([]);
		expect(replay.filter((u) => u.sessionUpdate === "plan_update")).toEqual([plans[2]]);
	});

	it("other clients get the standard single plan", async () => {
		const { live } = await chat({});
		const plans = live.filter((u) => u.sessionUpdate === "plan" || u.sessionUpdate === "plan_update");
		expect(plans.at(-1)).toEqual({ sessionUpdate: "plan", entries: items([["Read the code", "in_progress"], ["Fix the bug", "pending"]]) });
		expect(plans.every((u) => u.sessionUpdate === "plan")).toBe(true);
	});
});
