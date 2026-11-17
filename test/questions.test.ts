// The agent asks the user through a client form: codec shape, driver round trip, and Pi's ask_user tool.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decodeQuestionAnswers, encodeQuestionForm } from "../src/acp/codec.ts";
import { AcpAgent } from "../src/acp/agent.ts";
import type { QuestionForm } from "../src/core/types.ts";
import { formatAnswers } from "../src/pi/ask-user.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { FakeBackend, MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

const form: QuestionForm = {
	context: "I need two decisions.",
	questions: [
		{ name: "Database", question: "Which database?", options: [{ title: "Postgres", description: "Mature, already used here." }, { title: "SQLite", description: "No server." }] },
		{ name: "Features", options: [{ title: "Auth", description: "Login." }, { title: "Search", description: "Full text." }], allowMultiple: true },
		{ name: "Deadline", question: "When is it due?" },
	],
};

describe("question form codec", () => {
	it("encodes Junie's elicitation form shape", () => {
		const p = encodeQuestionForm("s1", form) as Obj;
		expect(p).toMatchObject({ sessionId: "s1", mode: "form", message: "I need two decisions.\n\nPlease answer the following questions." });
		const props = p.requestedSchema.properties;
		expect(Object.keys(props)).toEqual(["question_0", "question_0_custom", "question_1", "question_1_custom", "question_2"]);
		expect(props.question_0).toEqual({
			type: "string",
			title: "Database",
			description: "Which database?",
			oneOf: [
				{ const: "Postgres", title: "Postgres", description: "Mature, already used here." },
				{ const: "SQLite", title: "SQLite", description: "No server." },
			],
		});
		expect(props.question_1).toMatchObject({ type: "array", minItems: 0, items: { anyOf: [{ const: "Auth" }, { const: "Search" }] } });
		expect(props.question_0_custom._meta).toEqual({ _askUserQuestionCustomAnswer: true, jetbrains: { air: { customAnswer: true } } });
		expect(props.question_2).toEqual({ type: "string", title: "Deadline", description: "When is it due?" });
		expect(p.requestedSchema.required).toEqual([]);
	});

	it("decodes accept, decline and cancel", () => {
		const accepted = decodeQuestionAnswers(form, { action: "accept", content: { question_0: "SQLite", question_1: ["Auth", "Search"], question_1_custom: "also export", question_2: "Friday" } });
		expect(accepted).toEqual({
			action: "accept",
			answers: [{ selected: ["SQLite"] }, { selected: ["Auth", "Search"], text: "also export" }, { selected: [], text: "Friday" }],
		});
		expect(decodeQuestionAnswers(form, { action: "decline" })).toEqual({ action: "decline" });
		expect(decodeQuestionAnswers(form, undefined)).toEqual({ action: "cancel" });
	});

	it("tells the model the answers in Junie's words", () => {
		const text = formatAnswers(form, { action: "accept", answers: [{ selected: ["SQLite"] }, { selected: [], text: "none" }, { selected: [] }] });
		expect(text).toBe(
			'### Response for the question "Database"\nSelected options: SQLite\n\n### Response for the question "Features"\nFree text response: none\n\n### Response for the question "Deadline"\n(no response)',
		);
		expect(formatAnswers(form, { action: "decline" })).toContain("The user declined this form without answering. Do not ask the same questions again in this turn.");
	});
});

describe("driver", () => {
	async function connected(elicitation: unknown) {
		const wire = new MemoryWire();
		new AcpAgent(wire.agentTransport, new FakeBackend());
		let id = 0;
		const call = async (method: string, params: Obj = {}) => (await wire.send({ jsonrpc: "2.0", id: ++id, method, params })) as Obj;
		await call("initialize", { protocolVersion: 1, clientCapabilities: { elicitation } });
		return { wire, call };
	}

	it("asks through elicitation/create and returns the answers to the turn", async () => {
		const { wire, call } = await connected({ form: {}, url: {} });
		const asked: Obj[] = [];
		wire.clientHandler = (method, params) => {
			asked.push({ method, params });
			return { action: "accept", content: { question_0: "Blue", question_1: "because" } };
		};
		const s = await call("session/new", { cwd: "/tmp" });
		await call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "ask" }] });
		expect(asked.map((a) => [a.method, a.params.mode, a.params.message])).toEqual([["elicitation/create", "form", "Please answer the following questions."]]);
		const reply = wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("");
		expect(JSON.parse(reply)).toEqual({ action: "accept", answers: [{ selected: ["Blue"] }, { selected: [], text: "because" }] });
	});

	it("cancels the form when the turn is cancelled", async () => {
		const { wire, call } = await connected({ form: {} });
		wire.clientHandler = () => new Promise(() => {}); // the user never answers
		const s = await call("session/new", { cwd: "/tmp" });
		const pending = call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "ask" }] });
		await new Promise((r) => setTimeout(r, 10));
		await wire.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.result.sessionId } });
		await pending;
		expect(wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("")).toBe('{"action":"cancel"}');
	});
});

describe("Pi ask_user tool", () => {
	let script: (string | { tool: string; input: unknown })[] = [];
	const proxyP = startFakeProxy({ reply: () => script.shift() ?? "done", listing: (p) => (p.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined) });
	afterAll(async () => (await proxyP).close());

	async function session(questionForms: boolean) {
		const proxy = await proxyP;
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		return { proxy, s: await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), questionForms }) };
	}
	const toolNames = (body: Obj) => (body.tools ?? []).map((t: Obj) => t.name);

	it("asks the user without a permission prompt and gives the model the answers", async () => {
		const { proxy, s } = await session(true);
		script = [{ tool: "ask_user", input: { questions: [{ name: "Color", options: [{ title: "Red", description: "Warm." }, { title: "Blue", description: "Calm." }] }] } }, "Blue it is."];
		const asked: QuestionForm[] = [];
		const permissions: string[] = [];
		const updates: Obj[] = [];
		const before = proxy.requests.length;
		const r = await s.prompt(
			{ text: "pick a color with me", images: [] },
			(e) => e.kind === "tool" && updates.push(e.update),
			new AbortController().signal,
			async (p) => {
				permissions.push(p.toolName);
				return "allow_once";
			},
			async (f) => {
				asked.push(f);
				return { action: "accept", answers: [{ selected: ["Blue"] }] };
			},
		);
		expect(r.stop).toBe("end_turn");
		expect(permissions).toEqual([]);
		expect(asked[0].questions[0].name).toBe("Color");
		const posts = proxy.requests.slice(before).filter((q) => q.method === "POST");
		expect(toolNames(posts[0].body)).toContain("ask_user");
		expect(JSON.stringify(posts[1].body.messages)).toContain('### Response for the question \\"Color\\"\\nSelected options: Blue');
		expect(updates[0]).toMatchObject({ name: "ask_user", title: "Asked: Color", toolKind: "think" });
		expect(updates.at(-1)).toMatchObject({ id: updates[0].id, status: "completed" });
		expect(updates.at(-1)!.output).toContain("Selected options: Blue");
	});

	it("is not offered when the client cannot show forms", async () => {
		const { proxy, s } = await session(false);
		script = ["hi"];
		const before = proxy.requests.length;
		await s.prompt({ text: "hello", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");
		const post = proxy.requests.slice(before).find((q) => q.method === "POST")!;
		expect(toolNames(post.body)).not.toContain("ask_user");
	});
});
