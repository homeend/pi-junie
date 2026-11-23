// The web access plugin (pi-web-access): its tools are enabled (without the web_enable loader), shown as search/fetch
// rows, searching runs without asking, fetching asks outside Auto/Brave mode, and web_search never fetches pages in the
// background (that would start a run of its own after the turn).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { WEB_ACCESS_PLUGIN } from "../src/pi/plugins.ts";
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
				return { tool: "web_search", input: { query: "pi coding agent", includeContent: true } };
			case 1:
				return { tool: "fetch_content", input: { url: "https://example.com/guide" } };
			default:
				return "Done.";
		}
	},
});
afterAll(() => proxy.close());

/** Pi agent dir with a stand-in web access plugin: the four tools plus the web_enable loader; each echoes its input. */
function piAgentDirWithWebAccess(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	const pkg = join(agentDir, "npm", "node_modules", WEB_ACCESS_PLUGIN);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: WEB_ACCESS_PLUGIN, version: "0.48.0", pi: { extensions: ["./index.ts"] } }));
	writeFileSync(
		join(pkg, "index.ts"),
		`export default function (pi) {
			for (const name of ["web_search", "fetch_content", "get_search_content", "source_check", "web_enable"]) {
				pi.registerTool({
					name, label: name, description: name,
					parameters: { type: "object", properties: { query: { type: "string" }, url: { type: "string" }, includeContent: { type: "boolean" } } },
					async execute(_id, p) {
						return { content: [{ type: "text", text: name + " " + JSON.stringify(p) }], details: {} };
					},
				});
			}
		}`,
	);
	return agentDir;
}

async function chat(braveMode?: string) {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
	const backend = await PiBackend.create({ stateDir, piAgentDir: piAgentDirWithWebAccess() });
	const wire = new MemoryWire();
	const asked: Obj[] = [];
	wire.clientHandler = (method, params) => {
		if (method === "session/request_permission") asked.push(params);
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	};
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
	if (braveMode) await call("session/set_config_option", { sessionId: result.sessionId, configId: "brave_mode", value: braveMode });
	const before = proxy.requests.length;
	await call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "look it up" }] });
	const updates = wire.sent.filter((m) => m.method === "session/update").map((m) => (m.params as Obj).update);
	const toolNames = (proxy.requests[before]?.body.tools ?? []).map((t: Obj) => t.name);
	return { updates, asked, toolNames };
}

describe("web access", () => {
	it("enables the web tools without the loader, shows search and fetch rows, asks only for fetching in Safe mode", async () => {
		const { updates, asked, toolNames } = await chat("off");
		expect(toolNames).toEqual(expect.arrayContaining(["web_search", "fetch_content", "get_search_content", "source_check"]));
		expect(toolNames).not.toContain("web_enable");

		const rows = updates.filter((u) => u.sessionUpdate === "tool_call");
		expect(rows.map((r) => [r.kind, r.title])).toEqual([
			["search", 'Search the web: "pi coding agent"'],
			["fetch", "Fetch https://example.com/guide"],
		]);
		expect(asked.map((a) => a.toolCall.title)).toEqual(["Fetch https://example.com/guide"]);

		// the background page fetch is turned off before the search runs
		const searchOutput = JSON.stringify(updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === rows[0].toolCallId));
		expect(searchOutput).toContain('\\"includeContent\\":false');
	});

	it("fetches without asking in Auto mode (the default)", async () => {
		const { asked } = await chat();
		expect(asked).toEqual([]);
	});
});
