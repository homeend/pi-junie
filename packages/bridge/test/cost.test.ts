// Cost per prompt (Junie's JUNIE-6310): the chat's cost from its transcript in usage_update (it continues after a
// restart), the cost on session list rows, /stats with tokens and credits per model and per prompt, and the prompt
// usage log (JUNIE_LOG_PROMPT_USAGE).
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const proxy = await startFakeProxy({ reply: () => "done", listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined) });
afterAll(() => proxy.close());
const junieConfigDir = fileURLToPath(new URL("../../junie-config", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
const project = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
afterEach(() => {
	delete process.env.JUNIE_LOG_PROMPT_USAGE;
	delete process.env.JUNIE_HOME;
});

async function connect() {
	const backend = await PiBackend.create({ stateDir, bundledPlugins: [junieConfigDir] });
	const wire = new MemoryWire();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(5000);
	const costs = (sessionId: string) =>
		wire.sent.filter((m) => m.method === "session/update" && (m.params as Obj).sessionId === sessionId && (m.params as Obj).update.sessionUpdate === "usage_update").map((m) => (m.params as Obj).update.cost.amount as number);
	const text = (sessionId: string) =>
		wire.sent.filter((m) => m.method === "session/update" && (m.params as Obj).sessionId === sessionId && (m.params as Obj).update.sessionUpdate === "agent_message_chunk").map((m) => (m.params as Obj).update.content.text).join("");
	return { call, costs, text };
}

describe("cost per prompt", () => {
	it("reports the chat's cost, lists it, keeps it over a restart, and breaks it down per prompt", async () => {
		const home = mkdtempSync(join(tmpdir(), "junie-home-"));
		Object.assign(process.env, { JUNIE_LOG_PROMPT_USAGE: "true", JUNIE_HOME: home });
		const first = await connect();
		const sessionId = (await first.call("session/new", { cwd: project, mcpServers: [] })).result.sessionId;
		await first.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "first question" }] });
		await first.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "second question" }] });
		const [one, two] = first.costs(sessionId);
		expect(one).toBeGreaterThan(0);
		expect(two).toBeCloseTo(2 * one, 10);

		// the list row carries the cost
		const row = (await first.call("session/list", { cwd: project })).result.sessions[0];
		expect(row._meta.jetbrains.air.cost).toEqual({ amount: two, currency: "USD" });

		// a new process continues the total from the transcript
		const second = await connect();
		await second.call("session/load", { sessionId, cwd: project, mcpServers: [] });
		await second.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "third" }] });
		expect(second.costs(sessionId).at(-1)).toBeCloseTo(3 * one, 10);

		// /stats (and its aliases): per model and per prompt, in credits
		await second.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/cost" }] });
		const report = second.text(sessionId);
		expect(report).toContain("**Current session**");
		expect(report).toMatch(/- Cost: [\d.]+ credits/);
		expect(report).toContain("**air-anthropic/claude-sonnet-5-5**: 36 input tokens, 21 output, 3 calls");
		expect(report).toContain("- Last 3 prompts:");
		expect(report).toMatch(/\*\*Prompt 1\*\*: first question — 19 tokens, cost [\d.]+ credits/);
		expect(report).toContain("**Prompt 3**: third — 19 tokens");

		// the prompt usage log, one line per prompt, in Junie's format
		const logs = join(home, "logs");
		const log = readdirSync(logs).filter((f) => f.startsWith("log-prompt-")).map((f) => readFileSync(join(logs, f), "utf8")).join("");
		expect(log).toMatch(/JuniePromptUsage - prompt=1 tokens=19 cost=[\d.]+ credits text="first question"/);
		expect(log).toMatch(/prompt=2 tokens=19 .* text="second question"/);
	});
});
