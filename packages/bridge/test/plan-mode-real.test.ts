// Optional check against the real @narumitw/pi-plan-mode (not a stand-in): set PI_PLAN_MODE_AGENT_DIR to a Pi agent
// dir where it is installed (`<dir>/npm/node_modules/@narumitw/pi-plan-mode`, e.g. after `npm install` in <dir>/npm).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { type FakeRequest, LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const agentDir = process.env.PI_PLAN_MODE_AGENT_DIR;
const PLAN = "# Plan\n\n1. Add the flag\n2. Test it";

describe.skipIf(!agentDir)("real @narumitw/pi-plan-mode", () => {
	it("plans read-only, asks for review, implements in the same turn", async () => {
		const proxy = await startFakeProxy({
			listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
			reply: (req: FakeRequest) => {
				const t = JSON.stringify(req.body.messages);
				if (t.includes("Implement the plan")) return t.includes("touch done.txt") ? "Implemented." : { tool: "bash", input: { command: "touch done.txt" } };
				return t.includes('"name":"plan_mode_complete"') ? "Plan ready." : { tool: "plan_mode_complete", input: { plan: PLAN } };
			},
		});
		afterAll(() => proxy.close());
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), piAgentDir: agentDir });
		const wire = new MemoryWire();
		const asked: Obj[] = [];
		wire.clientHandler = (method, params) => {
			if (method !== "session/request_permission") return {};
			const p = params as Obj;
			asked.push(p);
			return { outcome: { outcome: "selected", optionId: p.toolCall.toolCallId.startsWith("plan-review:") ? "implement" : "allow_once" } };
		};
		new AcpAgent(wire.agentTransport, backend);
		let id = 0;
		const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 30000) as Promise<Obj>;
		await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: { plan: {} } });
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
		await call("session/set_config_option", { sessionId: result.sessionId, configId: "mode", value: "plan" });
		expect((await call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "plan the feature" }] })).result.stopReason).toBe("end_turn");
		const updates = wire.sent.filter((m) => m.method === "session/update").map((m) => (m.params as Obj).update);
		expect(updates).toContainEqual({ sessionUpdate: "plan_update", plan: { type: "markdown", id: "plan", content: PLAN } });
		expect(asked.map((a) => a.toolCall.title)).toEqual(["Implement this plan?", "Run touch done.txt"]);
		expect(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")).toContain("Implemented.");
		expect(updates.filter((u) => u.sessionUpdate === "config_option_update").at(-1).configOptions[0].currentValue).toBe("default");
	}, 60000);
});
