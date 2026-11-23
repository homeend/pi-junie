// Plan mode from @narumitw/pi-plan-mode, driven by the bridge: AIR's mode option and /plan toggle, the plan as a
// Markdown plan update, Junie's plan review, and the decision carried out with the plugin's commands.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { PLAN_MODE_PLUGIN } from "../src/pi/plugins.ts";
import { type FakeRequest, LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const transcript = (req: FakeRequest) => JSON.stringify(req.body.messages);
const PLAN = "# Plan\n\n1. Add the flag\n2. Test it";

const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: (req) => {
		const t = transcript(req);
		if (t.includes("Implement the plan.")) return t.includes("touch done.txt") ? "Implemented." : { tool: "bash", input: { command: "touch done.txt" } };
		if (t.includes("plan the feature")) return t.includes("plan_mode_complete") ? "Plan ready." : { tool: "plan_mode_complete", input: { plan: PLAN } };
		return "Hello.";
	},
});
afterAll(() => proxy.close());

/**
 * Stand-in for the plugin: `/plan start|exit|implement`, a `plan_mode_complete` tool, and its saved state as the
 * custom entry `plan-mode-state` (what the bridge reads). Implementing sends "Implement the plan." without awaiting
 * it, as the plugin does.
 */
function piAgentDirWithPlanMode(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	const pkg = join(agentDir, "npm", "node_modules", PLAN_MODE_PLUGIN);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PLAN_MODE_PLUGIN, version: "0.60.2", pi: { extensions: ["./index.ts"] } }));
	writeFileSync(
		join(pkg, "index.ts"),
		`export default function (pi) {
			let state = { enabled: false, awaitingAction: false };
			const save = (next) => { state = next; pi.appendEntry("plan-mode-state", state); };
			pi.registerTool({
				name: "plan_mode_complete", label: "Plan", description: "Submit the plan",
				parameters: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
				async execute(_id, p) { save({ ...state, latestPlan: p.plan, awaitingAction: true }); return { content: [{ type: "text", text: "Plan recorded." }], details: { plan: p.plan }, terminate: true }; },
			});
			pi.registerTool({ name: "plan_mode_question", label: "Question", description: "Ask", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ui_unavailable" }], details: {} }; } });
			pi.on("tool_call", (e) => (state.enabled && (e.toolName === "write" || e.toolName === "edit") ? { block: true, reason: "Plan mode blocks mutating tools" } : undefined));
			pi.registerCommand("plan", {
				description: "Plan mode",
				handler: async (args) => {
					if (args === "start") save({ enabled: true, awaitingAction: false });
					if (args === "exit") save({ enabled: false, awaitingAction: false });
					if (args === "implement") { save({ enabled: false, awaitingAction: false }); pi.sendUserMessage("Implement the plan."); }
				},
			});
		}`,
	);
	return agentDir;
}

async function connect(decision: string, clientCapabilities: Obj = { plan: {} }) {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), piAgentDir: piAgentDirWithPlanMode() });
	const wire = new MemoryWire();
	const asked: Obj[] = [];
	wire.clientHandler = (method, params: any) => {
		if (method !== "session/request_permission") return {};
		asked.push(params);
		return { outcome: { outcome: "selected", optionId: params.toolCall.toolCallId.startsWith("plan-review:") ? decision : "allow_once" } };
	};
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
	const sessionId: string = result.sessionId;
	const updates = () => wire.sent.filter((m) => m.method === "session/update").map((m) => (m.params as Obj).update);
	const prompt = (text: string) => call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	const mode = (configOptions: Obj[]) => configOptions.find((o) => o.id === "mode")?.currentValue;
	return { call, sessionId, newResult: result, updates, asked, prompt, mode };
}

describe("plan mode", () => {
	it("offers Junie's mode option and a /plan toggle that names it", async () => {
		const { newResult, updates } = await connect("implement");
		expect(newResult.configOptions[0]).toMatchObject({ id: "mode", currentValue: "default", options: [{ value: "default" }, { value: "plan" }] });
		await new Promise((r) => setTimeout(r, 50)); // the command list follows session/new
		const plan = updates().find((u) => u.sessionUpdate === "available_commands_update")?.availableCommands.find((c: Obj) => c.name === "plan");
		const commandAction = { kind: "setConfigOption", configId: "mode", value: "plan", resetValue: "default", presentation: "state" };
		expect(plan._meta).toEqual({ commandAction, jetbrains: { air: { commandAction } } });
	});

	it("implement: shows the plan, asks, and implements it in the same turn; the mode returns to Default", async () => {
		const { call, sessionId, updates, asked, prompt, mode } = await connect("implement");
		expect(mode((await call("session/set_config_option", { sessionId, configId: "mode", value: "plan" })).result.configOptions)).toBe("plan");
		expect((await prompt("plan the feature")).result.stopReason).toBe("end_turn");
		const all = updates();
		expect(all.find((u) => u.sessionUpdate === "plan_update")).toEqual({ sessionUpdate: "plan_update", plan: { type: "markdown", id: "plan", content: PLAN } });
		// the plan tool's row is the plan card itself
		expect(all.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.title)).toEqual(["Run touch done.txt"]);
		const review = asked[0];
		expect(review.toolCall).toMatchObject({ title: "Implement this plan?", kind: "other", rawInput: { plan: PLAN } });
		expect(review.options.map((o: Obj) => [o.optionId, o.kind])).toEqual([["implement", "allow_once"], ["revise", "reject_once"], ["stop", "reject_once"]]);
		expect(all).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: review.toolCall.toolCallId, status: "completed" });
		expect(all.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toContain("Implemented.");
		expect(mode(all.filter((u) => u.sessionUpdate === "config_option_update").at(-1).configOptions)).toBe("default");

		// reopening the chat shows the plan card again (not the plan tool's row)
		const sent = all.length;
		await call("session/load", { sessionId, cwd: (await call("session/list", {})).result.sessions[0].cwd, mcpServers: [] });
		const replay = updates().slice(sent);
		expect(replay).toContainEqual({ sessionUpdate: "plan_update", plan: { type: "markdown", id: "plan", content: PLAN } });
		expect(replay.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.title)).toEqual(["Run touch done.txt"]);
	});

	it("revise keeps plan mode (the next message revises); stop leaves it without implementing", async () => {
		const revise = await connect("revise");
		await revise.call("session/set_config_option", { sessionId: revise.sessionId, configId: "mode", value: "plan" });
		await revise.prompt("plan the feature");
		expect(revise.updates()).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed", title: "Plan kept for revision. Send changes to revise it." }));
		expect(revise.updates().some((u) => u.sessionUpdate === "config_option_update")).toBe(false);
		expect(revise.updates().some((u) => u.sessionUpdate === "tool_call" && u.title === "Run touch done.txt")).toBe(false);

		const stop = await connect("stop");
		await stop.prompt("/plan plan the feature"); // the command switches plan mode on and plans its task
		expect(stop.updates()).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed", title: "Plan not implemented." }));
		expect(stop.updates().filter((u) => u.sessionUpdate === "config_option_update").map((u) => stop.mode(u.configOptions))).toEqual(["plan", "default"]);
		expect(stop.updates().some((u) => u.sessionUpdate === "tool_call" && u.title === "Run touch done.txt")).toBe(false);
	});

	it("a client without plan updates gets the plan as a message", async () => {
		const { call, sessionId, updates, prompt } = await connect("revise", {});
		await call("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
		await prompt("plan the feature");
		expect(updates().some((u) => u.sessionUpdate === "plan_update")).toBe(false);
		expect(updates().filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text)).toContain(PLAN);
	});
});
