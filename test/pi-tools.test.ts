// Pi bridge tool calls end to end: a scripted fake model asks for tools, the bridge gates and reports them.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionRequest, ToolUpdate } from "../src/core/types.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

let script: (string | { tool: string; input: unknown; text?: string })[] = [];
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
		script = [{ tool: "bash", input: { command: "touch one.txt" } }, { tool: "bash", input: { command: "touch two.txt" } }, "both ran"];
		await run("echo twice", () => "allow_always");
		expect(asked).toHaveLength(1);
	});

	it("Brave Mode: Auto runs read-only commands without asking, Brave runs everything, Safe asks for every command", async () => {
		const auto = await chat();
		expect(auto.session.approvalMode()).toBe("auto"); // Junie's default
		script = [{ tool: "bash", input: { command: "git status && ls | head -3" } }, { tool: "bash", input: { command: "touch made.txt" } }, "done"];
		await auto.run("look, then write", () => "allow_once");
		expect(auto.asked.map((a) => a.title)).toEqual(["Run touch made.txt"]);
		// a command that ran without asking is reported running, not left pending
		const ls = auto.tools.filter((t) => (t.input as { command?: string } | undefined)?.command?.startsWith("git status"));
		expect(ls.map((t) => t.status)).toContain("in_progress");

		const brave = await chat();
		await brave.session.selectApprovalMode("brave");
		script = [{ tool: "write", input: { path: "b.txt", content: "x" } }, { tool: "bash", input: { command: "touch c.txt" } }, "done"];
		await brave.run("write things", () => "reject");
		expect(brave.asked).toEqual([]);
		expect(existsSync(join(brave.cwd, "b.txt")) && existsSync(join(brave.cwd, "c.txt"))).toBe(true);

		const safe = await chat();
		await safe.session.selectApprovalMode("safe");
		script = [{ tool: "bash", input: { command: "ls" } }, "done"];
		await safe.run("list", () => "allow_once");
		expect(safe.asked.map((a) => a.title)).toEqual(["Run ls"]);
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

	it("offers skills as commands and runs a skill through Pi's skill invocation", async () => {
		const { cwd, session, run } = await chat();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(cwd, ".agents", "skills", "release-notes"), { recursive: true });
		writeFileSync(
			join(cwd, ".agents", "skills", "release-notes", "SKILL.md"),
			"---\nname: release-notes\ndescription: Write release notes from the git log.\n---\n\nSTEP ONE: read the git log.\n",
		);
		const commands = await session.commands();
		// user-level ~/.agents/skills may add more skills on a developer machine
		expect(commands.slice(0, 2).map((c) => [c.name, c.kind])).toEqual([
			["new", "new_session"],
			["compact", "builtin"],
		]);
		const skill = commands.find((c) => c.name === "release-notes");
		expect(skill).toMatchObject({ kind: "skill", skillPath: join(cwd, ".agents", "skills", "release-notes", "SKILL.md") });
		script = ["drafting notes"];
		await session.prompt({ text: "$release-notes for v1.2", images: [], command: { name: "release-notes", args: "for v1.2" } }, () => {}, new AbortController().signal, async () => "allow_once");
		const user = JSON.stringify(proxy.requests.filter((r) => r.method === "POST").at(-1)!.body.messages);
		expect(user).toContain("STEP ONE: read the git log.");
		expect(user).toContain("for v1.2");
		void run;
	});

	it("/compact summarizes the conversation, and says so when there is nothing yet", async () => {
		const { session, run } = await chat();
		let text = "";
		const sink = (e: { kind: string; delta?: string }) => e.kind === "text" && (text += e.delta);
		await session.prompt({ text: "/compact", images: [], command: { name: "compact", args: "" } }, sink, new AbortController().signal, async () => "allow_once");
		expect(text).toBe("Nothing to compact yet.");
		script = ["first answer", "summary of the chat"];
		await run("remember 42", () => "allow_once");
		text = "";
		const r = await session.prompt({ text: "/compact keep numbers", images: [], command: { name: "compact", args: "keep numbers" } }, sink, new AbortController().signal, async () => "allow_once");
		expect(r.error).toBeUndefined();
		expect(r.stop).toBe("end_turn");
		// a short chat: Pi keeps recent turns, so there is nothing older to summarize yet
		expect(text).toMatch(/^(Compacted the conversation \(\d+ tokens before|Nothing to compact yet)/);
	});

	it("a message typed while a tool runs reaches the model before its next call (steer)", async () => {
		const { session } = await chat();
		expect(await session.steer({ text: "too early", images: [] })).toBe("not_running");
		script = [{ tool: "bash", input: { command: "sleep 0.3; echo slept" } }, "noted your message", "unused"];
		const steered: Promise<string>[] = [];
		const r = await session.prompt(
			{ text: "run a slow command", images: [] },
			(e) => {
				if (e.kind === "tool" && e.update.status === "in_progress" && !steered.length) steered.push(session.steer({ text: "STEERED: also say hi", images: [] }));
			},
			new AbortController().signal,
			async () => "allow_once",
		);
		expect(r.stop).toBe("end_turn");
		expect(await steered[0]).toBe("injected");
		const posts = proxy.requests.filter((req) => req.method === "POST");
		expect(posts).toHaveLength(2); // one turn: the steered message joined the second model call
		const second = JSON.stringify(posts[1].body.messages);
		expect(second).toContain("STEERED: also say hi");
		expect(second.indexOf("slept")).toBeLessThan(second.indexOf("STEERED"));
		expect(session.history().filter((h) => h.kind === "user").map((h) => (h as { text: string }).text)).toEqual(["run a slow command", "STEERED: also say hi"]);
		expect(await session.steer({ text: "too late", images: [] })).toBe("not_running");
	});

	it("a /compact typed during a turn is refused: it needs its own turn", async () => {
		const { session } = await chat();
		script = ["first"];
		let during: Promise<string> | undefined;
		const slow = session.prompt({ text: "x", images: [] }, () => {
			during ??= session.steer({ text: "/compact", images: [], command: { name: "compact", args: "" } });
		}, new AbortController().signal, async () => "allow_once");
		await slow;
		expect(await during).toBe("busy");
	});

	it("tags text before a tool call as commentary and the answer as final_answer, also in history", async () => {
		const { session } = await chat();
		script = [{ text: "Let me look.", tool: "ls", input: {} }, "Here are the files."];
		const chunks: [string, string | undefined][] = [];
		await session.prompt(
			{ text: "list files", images: [] },
			(e) => e.kind === "text" && chunks.push([e.delta, e.phase]),
			new AbortController().signal,
			async () => "allow_once",
		);
		const byPhase = (phase: string) => chunks.filter(([, p]) => p === phase).map(([d]) => d).join("");
		expect(byPhase("commentary")).toBe("Let me look.");
		expect(byPhase("final_answer")).toBe("Here are the files.");
		expect(chunks.every(([, p]) => p)).toBe(true);
		const replay = session.history().filter((h) => h.kind === "assistant");
		expect(replay).toEqual([
			{ kind: "assistant", text: "Let me look.", phase: "commentary" },
			{ kind: "assistant", text: "Here are the files.", phase: "final_answer" },
		]);
	});

	it("sums usage over all model calls of a tool turn", async () => {
		const { run } = await chat();
		script = [{ tool: "ls", input: {} }, "listed"];
		const r = await run("list", () => "allow_once");
		expect(r.usage).toMatchObject({ inputTokens: 24, outputTokens: 14 });
	});
});
