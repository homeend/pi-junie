// Plugins installed from a local path (`pi install <path>` lists the directory in the Pi agent dir's settings.json)
// are found there; Junie Cost ships with the bridge (packages/junie-cost) and is loaded by path.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { bundledPlugin, detectPlugins, JUNIE_COST_PLUGIN, WEB_ACCESS_PLUGIN } from "../src/pi/plugins.ts";
import { type FakeRequest, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

function agentDirWithPackages(packages: unknown[]): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
	return agentDir;
}

describe("local plugin packages", () => {
	it("finds a local package that `pi install <path>` listed in settings.json, by its package name", () => {
		const pkg = mkdtempSync(join(tmpdir(), "pi-junie-web-access-"));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: WEB_ACCESS_PLUGIN, version: "0.1.0", pi: { extensions: ["./index.ts"] } }));
		const other = mkdtempSync(join(tmpdir(), "pi-junie-other-"));
		writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else" }));
		// Pi stores the path relative to the agent dir
		const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@juicesharp/rpiv-todo", other, { source: "../missing" }, relative(agentDir, pkg)] }));
		expect(detectPlugins(agentDir)).toEqual([{ name: WEB_ACCESS_PLUGIN, version: "0.1.0", path: pkg }]);
		expect(detectPlugins(agentDirWithPackages(["../nothing-here"]))).toEqual([]);
	});

	it("tolerates a missing or broken settings.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
		expect(detectPlugins(agentDir)).toEqual([]);
		mkdirSync(join(agentDir, "npm"));
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		expect(detectPlugins(agentDir)).toEqual([]);
	});
});

const junieCostDir = fileURLToPath(new URL("../../junie-cost", import.meta.url));

describe("built-in Junie Cost in a bridge session", () => {
	it("is described by its package.json", () => {
		expect(bundledPlugin(junieCostDir)).toEqual({ name: JUNIE_COST_PLUGIN, version: "0.1.0", path: junieCostDir });
	});

	it("cuts long bash output for the model, summarizes it with the cheap model and keeps the full log", async () => {
		const summaryPrompt = (req: FakeRequest) => JSON.stringify(req.body.system ?? "").includes("Summarize the result of a tool call");
		const proxy = await startFakeProxy({
			listing: (path) =>
				path.endsWith("/v1/models")
					? [200, { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }], has_more: false }]
					: undefined,
			reply: (req) => {
				if (summaryPrompt(req)) return "Printed the numbers 1 to 5000.";
				return JSON.stringify(req.body.messages).includes("tool_result") ? "Done." : { tool: "bash", input: { command: "seq 1 5000" } };
			},
		});
		afterAll(() => proxy.close());
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), bundledPlugins: [junieCostDir] });
		const wire = new MemoryWire();
		wire.clientHandler = (method) => (method === "session/request_permission" ? { outcome: { outcome: "selected", optionId: "allow_once" } } : {});
		new AcpAgent(wire.agentTransport, backend);
		let id = 0;
		const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 30000) as Promise<Obj>;
		await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(5000);
		const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
		const prompt = await call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "count to 5000" }] });
		expect(prompt.result.stopReason).toBe("end_turn");

		// the cheap model summarized the output
		const summary = proxy.requests.find((r) => r.method === "POST" && summaryPrompt(r));
		expect(summary?.body.model).toBe("claude-haiku-5-5");
		// the main model got the cut output with the summary and a link to the full log, not 5000 lines
		const followUp = proxy.requests.filter((r) => r.method === "POST" && !summaryPrompt(r)).at(-1)!;
		const toolResult = JSON.stringify(followUp.body.messages.findLast((m: Obj) => JSON.stringify(m).includes("tool_result")));
		expect(toolResult).toContain("Printed the numbers 1 to 5000.");
		expect(toolResult).toContain("truncated");
		expect(toolResult).toContain(".outputs/");
		expect(toolResult.length).toBeLessThan(15_000);
		expect(toolResult).not.toContain("\\n2500\\n");
	}, 60000);
});
