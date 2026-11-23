// Commentary vs final answer from a streamed message (src/pi/phases.ts).
import { describe, expect, it } from "vitest";
import { PhaseSplitter, signaturePhase } from "../src/pi/phases.ts";

function splitter(options = { holdMs: 30, holdChars: 50 }) {
	const out: string[] = [];
	const s = new PhaseSplitter((d, p) => out.push(`${p}:${d}`), options);
	return { s, out };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PhaseSplitter", () => {
	it("text followed by a tool call is commentary, held text included", () => {
		const { s, out } = splitter();
		s.messageStart();
		s.text("Let me ");
		s.text("check.");
		expect(out).toEqual([]);
		s.toolCall();
		s.text(" more");
		s.messageEnd();
		expect(out).toEqual(["commentary:Let me check.", "commentary: more"]);
	});

	it("a message without tool calls is the final answer; streaming resumes after the hold", async () => {
		const { s, out } = splitter();
		s.messageStart();
		s.text("The answer");
		await wait(50);
		expect(out).toEqual(["final_answer:The answer"]);
		s.text(" is 42.");
		s.toolCall(); // too late to change: it already streams as the answer
		s.messageEnd();
		expect(out).toEqual(["final_answer:The answer", "final_answer: is 42."]);
	});

	it("long text stops being held; a provider phase decides at once", () => {
		const { s, out } = splitter();
		s.messageStart();
		s.text("x".repeat(60));
		expect(out).toEqual([`final_answer:${"x".repeat(60)}`]);
		s.messageStart();
		s.text("Working on it.");
		s.textEnd("commentary");
		expect(out.at(-1)).toBe("commentary:Working on it.");
		s.messageEnd();
	});

	it("reads the phase Pi stores in OpenAI text signatures", () => {
		expect(signaturePhase('{"v":1,"id":"msg_1","phase":"commentary"}')).toBe("commentary");
		expect(signaturePhase('{"v":1,"id":"msg_1"}')).toBeUndefined();
		expect(signaturePhase("msg_legacy")).toBeUndefined();
		expect(signaturePhase(undefined)).toBeUndefined();
	});
});

describe("phase on the wire", () => {
	it("carries Junie's phase keys on agent_message_chunk, live and in replay", async () => {
		const { encodeTurnEvent, encodeHistory } = await import("../src/acp/codec.ts");
		const meta = { codex: { phase: "commentary" }, jetbrains: { air: { phase: "commentary" } }, junie: { version: 1, phase: "commentary" } };
		expect(encodeTurnEvent({ kind: "text", delta: "Checking.", phase: "commentary" })).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking." }, _meta: meta });
		expect(encodeTurnEvent({ kind: "text", delta: "plain" })).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plain" } });
		expect(encodeHistory([{ kind: "assistant", text: "Done.", phase: "final_answer" }])[0]).toMatchObject({ _meta: { jetbrains: { air: { phase: "final_answer" } } } });
	});
});
