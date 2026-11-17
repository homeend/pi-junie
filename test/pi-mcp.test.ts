// The client's MCP server (like AIR's jetbrains_air_ide) reaches Pi: tools listed, read-only ones run freely.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PermissionRequest, ToolUpdate } from "../src/core/types.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

let script: (string | { tool: string; input: unknown })[] = [];
const proxy = await startFakeProxy({
	reply: () => script.shift() ?? "done",
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
});
afterAll(() => proxy.close());

describe("client MCP servers in Pi sessions", () => {
	it("exposes the server's tools; read-only tools run without asking, others ask", async () => {
		const callLog = join(mkdtempSync(join(tmpdir(), "pi-junie-mcp-")), "calls.log");
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		const session = await backend.openSession({
			cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")),
			mcpServers: [
				{ name: "test_ide", transport: "stdio", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-test-server.mjs")], env: { MCP_CALL_LOG: callLog } },
			],
		});
		script = [
			{ tool: "mcp__test_ide__get_open_file", input: {} },
			{ tool: "mcp__test_ide__reformat_file", input: { path: "src/Main.kt" } },
			"done",
		];
		const asked: PermissionRequest[] = [];
		const tools: ToolUpdate[] = [];
		const r = await session.prompt(
			{ text: "what is open? then reformat it", images: [] },
			(e) => e.kind === "tool" && tools.push(e.update),
			new AbortController().signal,
			async (req) => {
				asked.push(req);
				return "allow_once";
			},
		);
		expect(r.stop).toBe("end_turn");

		const declared = proxy.requests.find((q) => q.method === "POST")!.body.tools.map((t: { name: string }) => t.name);
		expect(declared).toEqual(expect.arrayContaining(["read", "bash", "mcp__test_ide__get_open_file", "mcp__test_ide__reformat_file"]));
		expect(asked.map((a) => [a.toolName, a.title])).toEqual([["mcp__test_ide__reformat_file", "test_ide · reformat_file"]]);
		expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual(["get_open_file", "reformat_file"]);
		const openFile = tools.find((t) => t.name === "mcp__test_ide__get_open_file" && t.status === "completed");
		expect(openFile?.output).toContain("src/Main.kt (line 12)");
		expect(tools.filter((t) => t.name === "mcp__test_ide__get_open_file").map((t) => t.status)).not.toContain("failed");
		await session.close();
	}, 20000);
});
