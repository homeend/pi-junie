// Eco mode (Junie's Model Mix) on the bridge's own providers: Junie's `eco` switch for an explicit Eco-capable model,
// planning on the selected model with junie-cost's create_plan / report_plan, the rest of the task on the
// implementation model (here Claude Haiku 5.5, the only one offered), and the choice remembered per model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { type FakeRequest, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const LISTING = { data: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"].map((id) => ({ id, display_name: id })), has_more: false };
const results = (req: FakeRequest) => JSON.stringify(req.body.messages);
const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTING] : undefined),
	reply: (req) => {
		const seen = results(req);
		if (!seen.includes("tool_result")) return { tool: "create_plan", input: {} };
		if (!seen.includes("IMPLEMENT FROM CREATE_PLAN")) return { tool: "report_plan", input: { plan: "1. Change the flag.", summary: "Change the flag." } };
		return "Implemented.";
	},
});
afterAll(() => proxy.close());
const junieCostDir = fileURLToPath(new URL("../../junie-cost", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));

async function connect() {
	const backend = await PiBackend.create({ stateDir, bundledPlugins: [junieCostDir] });
	const wire = new MemoryWire();
	wire.clientHandler = (method) => (method === "session/request_permission" ? { outcome: { outcome: "selected", optionId: "allow_once" } } : {});
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 30000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(5000);
	const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
	return { call, sessionId: result.sessionId as string, options: result.configOptions as Obj[] };
}
const eco = (options: Obj[]): Obj | undefined => options.find((o) => o.id === "eco");

describe("Eco mode", () => {
	it("offers Junie's switch, plans on the selected model and implements on the implementation model", async () => {
		const { call, sessionId, options } = await connect();
		// Sonnet 5.5 has no Eco mode in Junie: no switch, no toggle marker
		expect(eco(options)).toBeUndefined();
		const values = options.find((o) => o.id === "model")!.options.flatMap((g: Obj) => g.options);
		expect(values.find((v: Obj) => v.value === "pi:anthropic/claude-opus-5-5")?._meta).toEqual({ jetbrains: { air: { version: 1, eco: "toggle" } } });
		expect(values.find((v: Obj) => v.value === "pi:anthropic/claude-sonnet-5-5")?._meta).toBeUndefined();

		await call("session/set_config_option", { sessionId, configId: "model", value: "pi:anthropic/claude-opus-5-5" });
		const offered = (await call("session/set_config_option", { sessionId, configId: "effort", value: "high" })).result.configOptions;
		expect(eco(offered)).toEqual({ type: "boolean", id: "eco", name: "Eco", description: expect.any(String), category: "model_config", currentValue: false, _meta: { jetbrains: { air: { version: 1, kind: "eco" } } } });
		expect(eco((await call("session/set_config_option", { sessionId, configId: "eco", value: true })).result.configOptions)?.currentValue).toBe(true);

		proxy.requests.length = 0;
		const done = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Change the flag." }] });
		expect(done.result.stopReason).toBe("end_turn");
		// agent requests carry tools; Junie Cost's background summaries (on the cheap model) do not
		const agent = proxy.requests.filter((r) => r.method === "POST" && r.body.tools?.length);
		const models = agent.map((r) => r.body.model);
		expect(models).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
		// the implementation model gets the plan, not the planning
		const last = agent.at(-1)!;
		expect(results(last)).toContain("IMPLEMENT FROM CREATE_PLAN");
		expect(results(last)).not.toContain('"name":"report_plan"');

		// Eco cannot be set where it is not offered
		expect((await call("session/set_config_option", { sessionId, configId: "effort", value: "low" })).result).toBeDefined();
		expect((await call("session/set_config_option", { sessionId, configId: "eco", value: true })).error.code).toBe(-32602);
	});

	it("remembers the choice per model for new sessions", async () => {
		const { call, sessionId } = await connect();
		await call("session/set_config_option", { sessionId, configId: "model", value: "pi:anthropic/claude-opus-5-5" });
		const options = (await call("session/set_config_option", { sessionId, configId: "effort", value: "medium" })).result.configOptions;
		expect(eco(options)?.currentValue).toBe(true);
	});
});
