// The Eco route from the conversation alone (pi-junie change to COST-06 R3, R11, R14): per session, no shared state.
import { describe, expect, it } from "vitest";
import { implementationTurn } from "../src/model-mix/router.ts";
import { IMPLEMENT_FROM_PLAN } from "../src/model-mix/prompts.ts";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as any;
const assistant = (opts: { text?: string; calls?: number }) =>
	({
		role: "assistant",
		content: [
			...(opts.text ? [{ type: "text", text: opts.text }] : []),
			...Array.from({ length: opts.calls ?? 0 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "bash", arguments: {} })),
		],
	}) as any;
const result = (toolName: string, isError = false, text = "ok") => ({ role: "toolResult", toolName, toolCallId: "x", isError, content: [{ type: "text", text }] }) as any;

describe("Eco route from the conversation", () => {
	const planned = [user("fix it"), assistant({ calls: 1 }), result("create_plan"), assistant({ calls: 1 }), result("read"), assistant({ calls: 1 }), result("report_plan")];

	it("primary until a plan is accepted, then implementation", () => {
		expect(implementationTurn([user("fix it")])).toBe(false);
		expect(implementationTurn(planned.slice(0, 5))).toBe(false);
		expect(implementationTurn(planned)).toBe(true);
		expect(implementationTurn([...planned.slice(0, 6), result("report_plan", true)])).toBe(false);
	});

	it("the folded form (create_plan result with the implementation block) counts as an accepted plan", () => {
		expect(implementationTurn([user("fix it"), assistant({ calls: 1 }), result("create_plan", false, `plan\n\n${IMPLEMENT_FROM_PLAN}`)])).toBe(true);
	});

	it("a user message after the plan returns the task to the primary model", () => {
		expect(implementationTurn([...planned, assistant({ text: "done" }), user("also this")])).toBe(false);
	});

	it("after three failed implementation turns one request goes to the primary model, then back", () => {
		const failedTurn = [assistant({ calls: 1 }), result("bash", true)];
		const three = [...planned, ...failedTurn, ...failedTurn, ...failedTurn];
		expect(implementationTurn([...planned, ...failedTurn, ...failedTurn])).toBe(true);
		expect(implementationTurn(three)).toBe(false);
		expect(implementationTurn([...three, assistant({ calls: 1 }), result("bash")])).toBe(true);
		expect(implementationTurn([...three, ...failedTurn])).toBe(true); // the primary's turn resets the count
		expect(implementationTurn([...planned, assistant({}), assistant({}), assistant({})])).toBe(false); // no calls, no text
	});
});
