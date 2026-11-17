// Pi bridge tool calls end to end: a scripted fake model asks for tools, the bridge gates and reports them.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionRequest, ToolUpdate } from "../src/core/types.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

let script: (string | { tool: string; input: unknown })[] = [];
const proxy = await startFakeProxy({
	reply: () => script.shift() ?? "done",
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
});
afterAll(() => proxy.close());
beforeEach(() => {
	proxy.requests.length = 0;
});

async function chat() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
	const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
	const backend = await PiBackend.create({ stateDir });
	backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(3000);
	const session = await backend.openSession({ cwd });
	const asked: PermissionRequest[] = [];
	const tools: ToolUpdate[] = [];
	const run = async (text: string, decide: (r: PermissionRequest) => PermissionDecision) =>
		session.prompt(
			{ text, images: [] },
			(e) => e.kind === "tool" && tools.push(e.update),
			new AbortController().signal,
			async (r) => {
				asked.push(r);
				return decide(r);
			},
		);
	return { cwd, stateDir, session, asked, tools, run };
}

const toolResultTexts = () =>
	proxy.requests
		.filter((r) => r.method === "POST")
		.flatMap((r) => r.body.messages)
		.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
		.filter((c: any) => c.type === "tool_result")
		.map((c: any) => JSON.stringify(c.content));

describe("Pi bridge tools", () => {
	it("asks before write, then writes and reports a diff", async () => {
		const { cwd, asked, tools, run } = await chat();
		script = [{ tool: "write", input: { path: "hello.txt", content: "hi\n" } }, "written"];
		const r = await run("create hello.txt", () => "allow_once");
		expect(r.stop).toBe("end_turn");
		expect(asked.map((a) => [a.toolName, a.title, a.toolKind])).toEqual([["write", "Write hello.txt", "edit"]]);
		expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi\n");
		const end = tools.at(-1)!;
		expect(end.status).toBe("completed");
		expect(end.diff).toEqual({ path: join(cwd, "hello.txt"), oldText: null, newText: "hi\n" });
		expect(tools[0]).toMatchObject({ status: "pending", title: "Write hello.txt", locations: [{ path: join(cwd, "hello.txt") }] });
		// stays pending while the user is asked, runs only after approval
		expect(tools.map((t) => t.status)).toEqual(["pending", "pending", "in_progress", "completed"]);
	});

	it("a rejected tool does not run and the model is told", async () => {
		const { cwd, tools, run } = await chat();
		script = [{ tool: "bash", input: { command: "touch should-not-exist" } }, "ok, not running it"];
		await run("touch a file", () => "reject");
		expect(existsSync(join(cwd, "should-not-exist"))).toBe(false);
		expect(tools.at(-1)!.status).toBe("failed");
		expect(toolResultTexts().join()).toContain("rejected");
	});

	it("reads without asking and shows the edit location", async () => {
		const { cwd, asked, tools, run } = await chat();
		writeFileSync(join(cwd, "notes.md"), "line one\nline two\n");
		script = [{ tool: "read", input: { path: "notes.md" } }, { tool: "edit", input: { path: "notes.md", edits: [{ oldText: "line two", newText: "line 2" }] } }, "edited"];
		await run("fix notes", () => "allow_once");
		expect(asked.map((a) => a.toolName)).toEqual(["edit"]);
		expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("line one\nline 2\n");
		const editStart = tools.find((t) => t.name === "edit" && t.locations?.[0]?.line !== undefined)!;
		expect(editStart.locations).toEqual([{ path: join(cwd, "notes.md"), line: 2 }]);
		const readEnd = tools.find((t) => t.name === "read" && t.status === "completed")!;
		expect(readEnd.output).toContain("line two");
	});

	it("'Allow for this chat' is remembered per tool", async () => {
		const { asked, run } = await chat();
		script = [{ tool: "bash", input: { command: "echo one" } }, { tool: "bash", input: { command: "echo two" } }, "both ran"];
		await run("echo twice", () => "allow_always");
		expect(asked).toHaveLength(1);
	});

	it("puts the project's AGENTS.md and skills into the system prompt", async () => {
		const { cwd, run } = await chat();
		const { mkdirSync } = await import("node:fs");
		writeFileSync(join(cwd, "AGENTS.md"), "Always run `make check` before committing.\n");
		mkdirSync(join(cwd, ".agents", "skills", "release-notes"), { recursive: true });
		writeFileSync(
			join(cwd, ".agents", "skills", "release-notes", "SKILL.md"),
			"---\nname: release-notes\ndescription: Write release notes from the git log.\n---\n\nSteps...\n",
		);
		script = ["ok"];
		await run("hello", () => "allow_once");
		const system = JSON.stringify(proxy.requests.filter((r) => r.method === "POST").at(-1)!.body.system);
		expect(system).toContain("Always run `make check` before committing.");
		expect(system).toContain("release-notes");
		expect(system).toContain("JetBrains IDE");
	});

	it("replays tool calls with their final status when a chat is reopened", async () => {
		const { cwd, stateDir, session, run } = await chat();
		writeFileSync(join(cwd, "a.txt"), "alpha\n");
		script = [{ tool: "read", input: { path: "a.txt" } }, { tool: "bash", input: { command: "false" } }, "done reading"];
		await run("read a.txt then fail", (r) => (r.toolName === "bash" ? "reject" : "allow_once"));

		const reopened = await PiBackend.create({ stateDir });
		reopened.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await reopened.modelsSettled(3000);
		const history = (await reopened.resumeSession({ sessionId: session.id, cwd }))!.session.history();
		expect(history.map((h) => (h.kind === "tool" ? `tool:${h.update.name}:${h.update.status}` : h.kind))).toEqual([
			"user",
			"tool:read:completed",
			"tool:bash:failed",
			"assistant",
		]);
		const read = history[1] as Extract<(typeof history)[number], { kind: "tool" }>;
		expect(read.update).toMatchObject({ title: "Read a.txt", toolKind: "read", locations: [{ path: join(cwd, "a.txt") }] });
		expect(read.update.output).toContain("alpha");
	});

	it("reports bash as a terminal: command, output deltas, exit code", async () => {
		const { tools, run } = await chat();
		script = [{ tool: "bash", input: { command: "printf 'one\\ntwo\\n'" } }, { tool: "bash", input: { command: "echo oops >&2; exit 3" } }, "ran both"];
		await run("run things", () => "allow_once");
		const first = tools.filter((t) => t.input && (t.input as { command?: string }).command?.startsWith("printf"))[0];
		expect(first.terminal).toMatchObject({ command: "printf 'one\\ntwo\\n'" });
		const okEnd = tools.find((t) => t.name === "bash" && t.status === "completed")!;
		expect(okEnd.terminal?.exitCode).toBe(0);
		const streamed = tools.filter((t) => t.id === okEnd.id).map((t) => t.terminal?.delta ?? "").join("");
		expect(streamed).toContain("one\ntwo");
		expect(streamed.startsWith("one")).toBe(true); // no JSON of Pi's empty first progress event
		expect(tools.some((t) => t.terminal?.delta?.includes('"content"'))).toBe(false);
		const failed = tools.find((t) => t.name === "bash" && t.status === "failed")!;
		expect(failed.terminal?.exitCode).toBe(3);
	});

	it("sums usage over all model calls of a tool turn", async () => {
		const { run } = await chat();
		script = [{ tool: "ls", input: {} }, "listed"];
		const r = await run("list", () => "allow_once");
		expect(r.usage).toMatchObject({ inputTokens: 24, outputTokens: 14 });
	});
});
