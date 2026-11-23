import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
	type AgentBeforeSettleEvent, type ExtensionContext, generateUnifiedPatch, type SessionEntry, type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { limitOutput } from "./tool-output-processor.ts";

export const TASK_JOURNAL = "task-journal";
const OUTPUT_EXCERPT = { maxLines: 50, maxChars: 2000, maxLineLength: 500, edgeLines: 25 };

/** Facts about one finished task. Stored as a custom session entry, which the model never sees. */
export type TaskRecord = {
	/** Last branch entry covered by this record; the next record starts after it. */
	throughEntryId: string;
	requests: string[];
	solution?: string;
	patch?: string;
	/** Absolute paths of files created by the task. */
	created: string[];
	/** Absolute paths of files changed or created by the task. */
	modified?: string[];
	/** Absolute path to inclusive 1-based line ranges that were read. */
	viewed: Record<string, [number, number][]>;
	commands: { command: string; count: number; summary?: string; output?: string }[];
	rejections: { command: string; reason: string }[];
};

function resolvePath(cwd: string, path: string) {
	return resolve(cwd, path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir()));
}

/** Paths inside the working directory are shown relative to it, like in tool calls. */
export function displayPath(cwd: string, path: string) {
	const local = relative(cwd, path);
	return local && !local.startsWith("..") ? local : path;
}

export function journalRecords(entries: SessionEntry[]) {
	return entries.flatMap((entry) => entry.type === "custom" && entry.customType === TASK_JOURNAL ? [entry.data as TaskRecord] : []);
}

/** Command retellings of an automatic Junie compaction: command → retelling of its latest run up to that point. */
export function compactionRetellings(entry: SessionEntry) {
	return entry.type === "compaction" && entry.fromHook
		? (entry.details as { commandSummaries?: Record<string, string> } | undefined)?.commandSummaries : undefined;
}

/**
 * Build a record from the branch entries that follow the last journal record.
 * `snapshots` hold file contents before the first edit/write; `blocked` holds calls that never executed.
 */
export async function collectTask(
	entries: SessionEntry[], summaries: ReadonlyMap<string, string>, snapshots: ReadonlyMap<string, string | undefined>,
	blocked: ReadonlySet<string>, cwd: string,
): Promise<TaskRecord | undefined> {
	const journalIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === TASK_JOURNAL);
	const through = journalIndex < 0 ? -1 : entries.findIndex((entry) => entry.id === journalRecords([entries[journalIndex]])[0]?.throughEntryId);
	const start = (through < 0 ? journalIndex : through) + 1;
	const compactions = entries.flatMap((entry, index) => {
		const retellings = compactionRetellings(entry);
		return retellings ? [{ index, retellings }] : [];
	});
	const record: TaskRecord = { throughEntryId: "", requests: [], created: [], viewed: {}, commands: [], rejections: [] };
	const calls = new Map<string, ToolCall>();
	const commands = new Map<string, TaskRecord["commands"][number]>();
	let messages = 0;
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		messages++;
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content
				: message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			if (text.trim()) record.requests.push(text.trim());
		} else if (message.role === "assistant") {
			const tools = message.content.filter((block) => block.type === "toolCall");
			for (const call of tools) calls.set(call.id, call);
			const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
			if (!tools.length && text && message.stopReason === "stop") record.solution = text;
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (!call) continue;
			const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			const { path, offset, limit, command } = call.arguments;
			if (blocked.has(call.id)) {
				// A call interrupted between tool_call and execution was aborted, not rejected.
				if (message.isError && text !== "Operation aborted") {
					record.rejections.push({ command: typeof command === "string" ? command : `${call.name} ${JSON.stringify(call.arguments)}`, reason: text });
				}
			} else if (call.name === "read" && typeof path === "string" && text && !message.isError) {
				const start = typeof offset === "number" && offset > 1 ? offset : 1;
				// Without an explicit limit the plugin supplies its default window.
				const count = typeof limit === "number" && limit > 0 ? limit : start > 1 ? 300 : 100;
				(record.viewed[resolvePath(cwd, path)] ??= []).push([start, start + count - 1]);
			} else if (call.name === "bash" && typeof command === "string") {
				const count = (commands.get(command)?.count ?? 0) + 1;
				// A compaction right after the answer runs before this record is written; reuse what it retold.
				const summary = summaries.get(call.id)?.trim()
					|| compactions.find((compaction) => compaction.index > index)?.retellings[command];
				// Re-insert so that the map keeps commands in the order of their latest run.
				commands.delete(command);
				commands.set(command, { command, count, ...(summary ? { summary } : { output: limitOutput(text.trimEnd(), OUTPUT_EXCERPT) }) });
			}
		}
	}
	if (!messages) return undefined;
	record.throughEntryId = entries.at(-1)!.id;
	record.commands = [...commands.values()];
	const patches = [];
	const modified = [];
	for (const [path, before] of snapshots) {
		const after = await readFile(path, "utf8").catch(() => undefined);
		if (after === undefined || after === before) continue;
		if (before === undefined) record.created.push(path);
		modified.push(path);
		patches.push(generateUnifiedPatch(displayPath(cwd, path), before ?? "", after));
	}
	if (patches.length) {
		record.patch = patches.join("\n");
		record.modified = modified;
	}
	return record;
}

/** Session-local state for the journal: file snapshots for patches and calls blocked before execution. */
export function createTaskJournal(summaries: ReadonlyMap<string, string>) {
	const snapshots = new Map<string, string | undefined>();
	const unexecuted = new Set<string>();
	function reset() {
		snapshots.clear();
		unexecuted.clear();
	}
	return {
		reset,
		/** Remember the file as it was before the task's first edit/write; like Junie, patches ignore bash changes. */
		async handleToolCall(event: ToolCallEvent, ctx: ExtensionContext) {
			unexecuted.add(event.toolCallId);
			if (event.toolName !== "edit" && event.toolName !== "write" || typeof event.input.path !== "string") return;
			const path = resolvePath(ctx.cwd, event.input.path);
			if (snapshots.has(path)) return;
			try {
				snapshots.set(path, await readFile(path, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") snapshots.set(path, undefined);
			}
		},
		/** Pi emits tool_result only for calls that ran; calls blocked by a later tool_call handler never get here. */
		handleToolResult(event: { toolCallId: string }) {
			unexecuted.delete(event.toolCallId);
		},
		/** Record for messages that are not journaled yet, e.g. when compaction runs before settlement. */
		collect(ctx: ExtensionContext, entries = ctx.sessionManager.getBranch()) {
			return collectTask(entries, summaries, snapshots, unexecuted, ctx.cwd);
		},
		/**
		 * Append one journal entry for everything since the previous one. An aborted or failed run is
		 * left for the next record, together with its snapshots.
		 */
		async handleBeforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
			if (event.outcome !== "completed") return;
			try {
				const record = await collectTask(ctx.sessionManager.getBranch(), summaries, snapshots, unexecuted, ctx.cwd);
				if (!record) return;
				reset();
				return { entries: [...event.entries, { type: "custom" as const, customType: TASK_JOURNAL, data: record }] };
			} catch {
				// The journal is an optimization; never prevent the run from settling.
			}
		},
	};
}
