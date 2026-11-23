import { resolve } from "node:path";
import type { Api, Model, ToolCall } from "@earendil-works/pi-ai";
import type {
	ContextEditEntryDraft, ExtensionContext, MessageEndEvent, ProjectedSessionEntry, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

const CACHE_TTL_MS = 310_000;
const MIN_DELTA = 30_000;
const KEEP_TURNS = { read: 15, search: 10, run: 10 };

function messageText(message: MessageEndEvent["message"]): string {
	if ("content" in message) {
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => {
			switch (block.type) {
				case "text": return block.text;
				case "thinking": return block.thinking;
				case "toolCall": return `${block.name} ${JSON.stringify(block.arguments)}`;
				default: return "[image]";
			}
		}).join("\n");
	}
	if ("summary" in message) return message.summary;
	if ("output" in message) return message.output;
	return "";
}

/** Only the first literal command matters here; this does not change bash execution or display. */
export function historyCategory(call: ToolCall) {
	if (call.name === "read") return "read";
	if (["grep", "find", "ls"].includes(call.name)) return "search";
	if (call.name === "bash") {
		const search = typeof call.arguments.command === "string"
			&& /^\s*(?:[^\s'"`;|&<>]+\/)?(?:rg|grep|find|fd|ls)(?=\s|[;|&<>]|$)/.test(call.arguments.command);
		return search ? "search" : "run";
	}
	return undefined;
}

/** Junie's windows count complete tool turns, not individual (possibly parallel) calls. */
export function planHistoryEdits(projected: ProjectedSessionEntry[], summaries: ReadonlyMap<string, string>, cwd: string) {
	const calls = new Map<string, { call: ToolCall; turn: number; start: number }>();
	const edited = new Set(projected.flatMap(({ sourceEntry }) => sourceEntry.type === "context_edit" ? [sourceEntry.targetId] : []));
	const results = [];
	const lengths = projected.map(({ messages }) => messages.reduce((sum, message) => sum + messageText(message).length, 0));
	let toolTurns = 0;
	let lastAssistant = projected.length;
	for (const [index, entry] of projected.entries()) {
		for (const message of entry.messages) {
			if (message.role === "assistant") {
				lastAssistant = index;
				const tools = message.content.filter((block) => block.type === "toolCall");
				if (tools.length) toolTurns++;
				for (const call of tools) calls.set(call.id, { call, turn: toolTurns, start: index });
			} else if (message.role === "toolResult") {
				const request = calls.get(message.toolCallId);
				if (request) results.push({ ...request, message, index, id: entry.sourceEntry.id });
			}
		}
	}
	const entries: ContextEditEntryDraft[] = [];
	const seenFiles = new Set<string>();
	let delta = 0;
	let firstChanged = projected.length;
	for (const result of results.reverse()) {
		const { call, message, turn, start, index, id } = result;
		let eligible = false;
		if (["write", "create"].includes(call.name)) {
			// Like Junie, deduplicate only the prefix: the protected last five turns are untouched.
			if (turn > toolTurns - 5 || message.isError) continue;
			const path = call.arguments.path ?? call.arguments.filename;
			if (typeof path !== "string") continue;
			const key = path.startsWith("~") ? path : resolve(cwd, path);
			eligible = seenFiles.has(key);
			seenFiles.add(key);
		} else {
			const category = historyCategory(call);
			eligible = category !== undefined && turn <= toolTurns - KEEP_TURNS[category];
		}
		// Respect other extensions' edits and never discard images or an unmatched tool result.
		if (!eligible || edited.has(id) || message.content.some((block) => block.type !== "text")) continue;
		const summary = summaries.get(message.toolCallId)?.trim();
		const text = (summary || `[Earlier ${call.name} output omitted.]`) + (message.isError ? "\n[Tool reported an error.]" : "");
		const saved = lengths[index] - text.length;
		if (saved <= 0) continue;
		entries.push({ type: "context_edit", targetId: id, replacement: { content: text } });
		delta += saved;
		lengths[index] -= saved;
		firstChanged = Math.min(firstChanged, start);
	}
	return {
		entries: entries.reverse(), delta, toolTurns,
		historyChars: lengths.reduce((sum, length) => sum + length, 0) + delta,
		// The current turn is new, not cached. Re-cache the changed prefix's retained tail only.
		recacheChars: lengths.slice(firstChanged, lastAssistant).reduce((sum, length) => sum + length, 0),
	};
}

/** Cost/safety gates from UnlimitedStepsHistoryProcessor.shouldCompact; no model calls. */
export function shouldThinHistory(
	plan: ReturnType<typeof planHistoryEdits>, model: Model<Api>, nextInputTokens: number | undefined, idleMs: number,
) {
	if (plan.delta <= 0) return false;
	const nearLimit = model.contextWindow > 0 && nextInputTokens !== undefined
		&& nextInputTokens > model.contextWindow * (model.contextWindow > 300_000 ? 0.95 : 0.9);
	const dead = idleMs > CACHE_TTL_MS * 2;
	if (plan.toolTurns <= 10 && !nearLimit && !dead) return false;
	if (nearLimit) return true;
	if (dead && plan.delta > MIN_DELTA || idleMs > CACHE_TTL_MS && plan.delta > MIN_DELTA * 2) return true;
	const id = model.id.split("/").at(-1)!.toLowerCase();
	const anthropic = model.api === "anthropic-messages" || model.provider === "anthropic" || id.startsWith("claude-");
	const google = model.api.startsWith("google") || id.startsWith("gemini-");
	const xai = model.provider === "xai" || id.startsWith("grok-");
	const coefficient = anthropic ? (/^claude-(?:fable-5-1|opus-5-5)(?:-|$)/.test(id) ? 4 : 2) : google ? 2 : xai ? 1.5 : 1;
	const cacheCost = anthropic ? 1.25 : 1;
	return plan.delta > MIN_DELTA && (
		plan.delta > plan.recacheChars * cacheCost * coefficient
		|| plan.delta > 150_000 * coefficient && plan.historyChars > 300_000 * coefficient && plan.delta > 0.7 * plan.recacheChars * cacheCost
		|| plan.historyChars > 600_000 * coefficient
	);
}

/** Create session-local history hooks that reuse ready summaries without making model calls. */
export function createUnlimitedHistoryProcessor(summaries: ReadonlyMap<string, string>) {
	let lastRequest: { message: MessageEndEvent["message"]; completedAt: number } | undefined;
	return {
		/** Forget the previous session's response timing; leave the shared summary cache untouched. */
		reset() { lastRequest = undefined; },
		/** Record successful assistant completion time to estimate prompt-cache age at turn end. */
		handleMessageEnd({ message }: MessageEndEvent) {
			if (message.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) {
				lastRequest = { message, completedAt: Date.now() };
			}
		},
		/**
		 * After a completed turn, estimate the next input size and check thinning vs. re-cache cost.
		 * Append context edits without changing original messages; undefined leaves existing edits unchanged.
		 */
		handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
			if (event.outcome !== "completed" || ctx.signal?.aborted || !ctx.model) return;
			const projected = event.context.contextEntries;
			const assistantIndex = projected.findIndex(({ sourceEntry }) => sourceEntry.id === event.messageEntryId);
			const message = projected[assistantIndex]?.messages.find((message) => message.role === "assistant");
			if (!message || message.role !== "assistant") return;
			const model = ctx.modelRegistry.find(message.provider, message.model) ?? ctx.model;
			const { usage } = message;
			const tailChars = [...projected.slice(assistantIndex + 1).flatMap(({ messages }) => messages), ...event.context.pendingMessages]
				.reduce((sum, tail) => sum + (tail.role === "assistant" ? 0 : messageText(tail).length), 0);
			const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
			const nextInput = tokens > 0 ? tokens + tailChars / 3 : undefined;
			const completedAt = lastRequest?.message === event.message ? lastRequest.completedAt : message.timestamp;
			const plan = planHistoryEdits(projected, summaries, ctx.cwd);
			if (shouldThinHistory(plan, model, nextInput, Date.now() - completedAt)) {
				return { entries: [...event.entries, ...plan.entries] };
			}
		},
	};
}