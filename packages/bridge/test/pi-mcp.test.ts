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

	it("loads the client's skills from its skill roots and explains the IDE router", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const root = mkdtempSync(join(tmpdir(), "pi-junie-air-view-"));
		mkdirSync(join(root, ".agents", "skills", "ij-debugger"), { recursive: true });
		writeFileSync(join(root, ".agents", "skills", "ij-debugger", "SKILL.md"), "---\nname: ij-debugger\ndescription: Debug JVM code with execute_tool.\n---\n\nUse execute_tool.\n");
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		const session = await backend.openSession({
			cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")),
			skillRoots: [root],
			mcpServers: [{ name: "jetbrains_air_ide", transport: "stdio", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-test-server.mjs")], env: {} }],
		});
		script = ["ok"];
		await session.prompt({ text: "hi", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");
		const system = JSON.stringify(proxy.requests.filter((q) => q.method === "POST").at(-1)!.body.system);
		expect(system).toContain("ij-debugger");
		expect(system).toContain("Do not cycle through guessed names");
		await session.close();
	}, 20000);

	async function ideChat(junieCompat?: { executeToolAlias: boolean }) {
		const callLog = join(mkdtempSync(join(tmpdir(), "pi-junie-mcp-")), "calls.log");
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), junieCompat });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		const session = await backend.openSession({
			cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")),
			mcpServers: [
				{ name: "jetbrains_air_ide", transport: "stdio", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-test-server.mjs")], env: { MCP_ROUTER: "1", MCP_CALL_LOG: callLog } },
			],
		});
		const asked: PermissionRequest[] = [];
		const tools: ToolUpdate[] = [];
		const run = (text: string) =>
			session.prompt({ text, images: [] }, (e) => e.kind === "tool" && tools.push(e.update), new AbortController().signal, async (req) => {
				asked.push(req);
				return "allow_once";
			});
		const declared = () => proxy.requests.filter((q) => q.method === "POST").at(-1)!.body.tools as { name: string; description: string }[];
		return { session, asked, tools, run, declared, callLog };
	}

	it("Junie compat: the IDE router is the model's `execute_tool` with Junie's description, one prompt, one card", async () => {
		const { session, asked, tools, run, declared, callLog } = await ideChat();
		script = [{ tool: "execute_tool", input: { command: "get_file_problems --filePath src/A.kt" } }, "no problems"];
		const r = await run("inspect src/A.kt in the IDE");
		expect(r.stop).toBe("end_turn");
		const names = declared().map((t) => t.name);
		expect(names).toContain("execute_tool");
		expect(names).not.toContain("mcp__jetbrains_air_ide__execute_tool");
		expect(declared().find((t) => t.name === "execute_tool")!.description).toContain("Controls the connected JetBrains IDE");
		expect(asked.map((a) => [a.toolName, a.title])).toEqual([["execute_tool", "IDE: get_file_problems --filePath src/A.kt"]]);
		expect(new Set(tools.map((t) => t.id)).size).toBe(1); // the forwarded MCP call has no card of its own
		expect(tools.at(-1)).toMatchObject({ status: "completed", output: "no problems in src/A.kt" });
		expect(readFileSync(callLog, "utf8").trim()).toBe("execute_tool");
		const system = JSON.stringify(proxy.requests.filter((q) => q.method === "POST").at(-1)!.body.system);
		expect(system).toContain("The IDE tool `execute_tool`");
		await session.close();
	}, 20000);

	it("with the Junie alias off, the router keeps its MCP name", async () => {
		const { session, run, declared } = await ideChat({ executeToolAlias: false });
		script = ["ok"];
		await run("hi");
		const names = declared().map((t) => t.name);
		expect(names).toContain("mcp__jetbrains_air_ide__execute_tool");
		expect(names).not.toContain("execute_tool");
		await session.close();
	}, 20000);
});
