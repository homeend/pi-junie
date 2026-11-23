/**
 * Usage and cost of a Pi session, per session, per model and per prompt, computed from the session's entries (so it
 * survives restarts and needs no storage of its own), with Junie's formats (JUNIE-6310, cost per prompt).
 *
 * Counted: every assistant response (its `usage`), Pi `usage` entries (e.g. Junie Cost's cheap-model summaries) and
 * compaction / branch summaries with usage. A prompt is a user message and everything after it up to the next one.
 * Subagent runs live in their own sessions, so they are not in a prompt's totals (Junie: e4100c6f7f).
 *
 * Junie sources (junie-agent f38ae6e44c): `tui/app/state/session/PromptUsage.kt` (preview 100 chars, log text 100
 * lines, 100 prompts tracked), `utils/formatCost.kt` (credits: 1 credit = 1 USD), `tui/app/state/StatsFormat.kt`
 * (compact numbers), `logging/PromptUsageLog.kt` (the log line).
 */

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Model requests counted. */
	calls: number;
}

export interface PromptUsage {
	/** 1-based. */
	index: number;
	/** The prompt, whitespace collapsed, at most 100 characters. */
	preview: string;
	/** The prompt's first 100 lines (Junie's prompt log text). */
	text: string;
	totals: UsageTotals;
}

export interface SessionUsage {
	total: UsageTotals;
	/** `provider/model` -> totals, in order of first use. */
	byModel: Map<string, UsageTotals>;
	/** The last 100 prompts. */
	prompts: PromptUsage[];
	/** A free model (Junie Lite) answered: a total of 0 is then a real cost, not an unknown one. */
	freeUsed: boolean;
}

export const MAX_TRACKED_PROMPTS = 100;
const MAX_PREVIEW_CHARS = 100;
const MAX_LOG_LINES = 100;

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
type Entry = { type: string; message?: { role?: string; content?: unknown; usage?: Usage; provider?: string; model?: string }; usage?: Usage; provider?: string; model?: string };

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

/** Junie's token count of a request: input, cached input, cache writes and output. */
export const totalTokens = (t: UsageTotals) => t.input + t.cacheRead + t.cacheWrite + t.output;

function add(to: UsageTotals, u: Usage): void {
	to.input += u.input ?? 0;
	to.output += u.output ?? 0;
	to.cacheRead += u.cacheRead ?? 0;
	to.cacheWrite += u.cacheWrite ?? 0;
	to.cost += u.cost?.total ?? 0;
	to.calls += 1;
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
}

/** `isFree(provider, model)`: models that cost nothing by design (Junie Lite), whose 0 is reported as such. */
export function sessionUsage(entries: readonly unknown[], isFree: (provider: string, model: string) => boolean = () => false): SessionUsage {
	const total = emptyTotals();
	const byModel = new Map<string, UsageTotals>();
	const prompts: PromptUsage[] = [];
	let freeUsed = false;
	const count = (u: Usage | undefined, provider: string | undefined, model: string | undefined) => {
		if (!u) return;
		add(total, u);
		if (provider && model) {
			const key = `${provider}/${model}`;
			if (!byModel.has(key)) byModel.set(key, emptyTotals());
			add(byModel.get(key)!, u);
			if (isFree(provider, model)) freeUsed = true;
		}
		const current = prompts.at(-1);
		if (current) add(current.totals, u);
	};
	for (const raw of entries) {
		const e = raw as Entry;
		if (e.type === "message" && e.message?.role === "user") {
			const text = promptText(e.message.content);
			prompts.push({
				index: prompts.length + 1,
				preview: text.replace(/\s+/g, " ").trim().slice(0, MAX_PREVIEW_CHARS),
				text: text.split("\n").slice(0, MAX_LOG_LINES).join("\n"),
				totals: emptyTotals(),
			});
		} else if (e.type === "message" && e.message?.role === "assistant") count(e.message.usage, e.message.provider, e.message.model);
		else if (e.type === "usage") count(e.usage, e.provider, e.model);
		else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) count(e.usage, undefined, undefined);
	}
	return { total, byModel, prompts: prompts.slice(-MAX_TRACKED_PROMPTS), freeUsed };
}

/** The session cost to report (Junie's AcpCostPolicy): known when positive, or 0 when a free model answered. */
export function reportedCost(usage: SessionUsage): number | undefined {
	return usage.total.cost > 0 || usage.freeUsed ? usage.total.cost : undefined;
}

/** Junie's formatCost: 2 decimals from 0.10, 4 from 0.001, else 6; trailing zeros dropped. */
export function formatCost(cost: number): string {
	if (cost === 0) return "0.00";
	const digits = cost >= 0.1 ? 2 : cost >= 0.001 ? 4 : 6;
	return cost.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Junie's formatCredits: every amount as JetBrains credits (1 credit = 1 USD). */
export function formatCredits(cost: number): string {
	return `${formatCost(cost)}${cost === 1 ? " credit" : " credits"}`;
}

/** Junie's formatStatsNumber: `1234` -> `1.2k`, `2500000` -> `2.5M`. */
export function formatStatsNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Junie's prompt usage log line (without the logger's time and level prefix). */
export function promptUsageLogMessage(p: PromptUsage): string {
	return `prompt=${p.index} tokens=${totalTokens(p.totals)} cost=${formatCredits(p.totals.cost)} text=${JSON.stringify(p.text)}`;
}
