import { describe, expect, it } from "vitest";
import { formatCost, formatCredits, formatStatsNumber, promptUsageLogMessage, reportedCost, sessionUsage, totalTokens } from "../src/usage.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const reply = (model: string, cost: number, input = 100, output = 10, cacheRead = 0) => ({
	type: "message",
	message: { role: "assistant", provider: "air-anthropic", model, usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: cost } } },
});

describe("session usage", () => {
	it("sums the session, per model and per prompt; Pi usage entries (Junie Cost summaries) count", () => {
		const usage = sessionUsage([
			user("first   question\nwith two lines"),
			reply("claude-opus-5-5", 0.5),
			{ type: "usage", provider: "air-anthropic", model: "claude-haiku-5-5", usage: { input: 50, output: 5, cost: { total: 0.01 } } },
			reply("claude-opus-5-5", 0.25, 200, 20, 100),
			user("second"),
			reply("claude-haiku-5-5", 0.02),
			{ type: "custom", customType: "junie-config", data: {} },
		]);
		expect(usage.total).toMatchObject({ cost: 0.78, calls: 4 });
		expect([...usage.byModel.keys()]).toEqual(["air-anthropic/claude-opus-5-5", "air-anthropic/claude-haiku-5-5"]);
		expect(usage.byModel.get("air-anthropic/claude-haiku-5-5")).toMatchObject({ cost: 0.03, calls: 2 });
		expect(usage.prompts.map((p) => [p.index, p.preview, totalTokens(p.totals), p.totals.cost])).toEqual([
			[1, "first question with two lines", 485, 0.76],
			[2, "second", 110, 0.02],
		]);
		expect(reportedCost(usage)).toBeCloseTo(0.78);
	});

	it("a zero total is unknown unless a free model answered (Junie's AcpCostPolicy)", () => {
		expect(reportedCost(sessionUsage([user("x"), reply("m", 0)]))).toBeUndefined();
		expect(reportedCost(sessionUsage([user("x"), reply("lite", 0)], (_p, m) => m === "lite"))).toBe(0);
	});

	it("Junie's formats", () => {
		expect([formatCost(0), formatCost(0.5), formatCost(12.345), formatCost(0.0123), formatCost(0.000123)]).toEqual(["0.00", "0.5", "12.35", "0.0123", "0.000123"]);
		expect([formatCredits(1), formatCredits(0.25)]).toEqual(["1 credit", "0.25 credits"]);
		expect([formatStatsNumber(999), formatStatsNumber(1234), formatStatsNumber(2_500_000)]).toEqual(["999", "1.2k", "2.5M"]);
		const [p] = sessionUsage([user('fix "it"'), reply("m", 0.5)]).prompts;
		expect(promptUsageLogMessage(p)).toBe('prompt=1 tokens=110 cost=0.5 credits text="fix \\"it\\""');
	});
});
