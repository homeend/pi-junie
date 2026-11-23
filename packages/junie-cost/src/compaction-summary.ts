import { readFile } from "node:fs/promises";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createSummarizationClient } from "./summarization-client.ts";
import { compactionRetellings, displayPath, TASK_JOURNAL, type TaskRecord } from "./task-journal.ts";

const PREFIX = "History processor:";
const CHANGES_SEPARATOR = "\n\n=== changes block separator ===\n\n";
const COMMANDS_PROMPT = [
	"Below is a list of commands and the system’s responses.",
	"For each command provide the exact command and give a concise summary of the system’s response, based on the command type:",
	"- Run Tests: Summarize the results. If any tests failed, list which ones and explain why they failed.",
	"- Run Other Scripts: Summarize the results. If a script failed, mention the main reason.",
	"- Software Installation: Specify which software was installed and its version. If the installation failed, state the main reason.",
	"- Other: Give a brief summary of the response with mention of important details.",
	"",
	"Do not include interpretations; simply summarize what you observe.",
	"Place all information about one command on a single line. Avoid `command` and `response` in any form in your answer, just provide requested information.",
	"Always enclose the command in backticks (`) exactly as shown below. Use format:",
	"`some command`: Summary of the response.",
].join("\n");

type Command = TaskRecord["commands"][number];
type Summaries = Record<string, string>;

const singleLine = (text: string) => text.trim().split("\n").map((line) => line.trim()).join(" | ");

function renderTasks(records: TaskRecord[], hard: boolean) {
	const tasks = records.filter((record) => record.requests.length || record.solution);
	if (!tasks.length) return undefined;
	const kept = hard ? tasks.slice(-10) : tasks;
	const lines = [
		`${PREFIX} During the current session, you have worked on the following \`<previous_issue>\`.`,
		"The next user request usually continues or extends your previous work. Consider all `<previous_issue>` and the next request together.",
	];
	if (kept.length < tasks.length) lines.push("...\n[Earlier tasks were omitted by the on-demand compression.]");
	for (const [index, task] of kept.entries()) {
		lines.push(`<previous_issue>\n${task.requests.join("\n\n")}\n</previous_issue>`);
		if (hard && index < kept.length - 5) lines.push("...\n[Solution and other details were omitted by the on-demand compression.]");
		else if (task.solution) lines.push(`<previous_issue_solution>\n${task.solution}\n</previous_issue_solution>`);
	}
	return lines.join("\n");
}

/** Junie's printOneFile: current content of the viewed ranges; nearby ranges merge, mostly-viewed files print whole. */
async function renderFile(cwd: string, path: string, ranges: [number, number][]) {
	const content = await readFile(path, "utf8").catch(() => undefined);
	if (!content) return undefined;
	const lines = content.replace(/\n$/, "").split("\n");
	const total = lines.length;
	let merged: [number, number][] = [];
	for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
		if (start > total) break;
		const last = merged.at(-1);
		if (last && start - last[1] <= 20) last[1] = Math.max(last[1], Math.min(end, total));
		else merged.push([start, Math.min(end, total)]);
	}
	if (!merged.length) return undefined;
	const last = merged.at(-1)!;
	if (total - last[1] < 20) last[1] = total;
	if (total < 200 || merged.reduce((sum, [start, end]) => sum + end - start, 0) / total > 0.8) merged = [[1, total]];
	const output = [`[File: ${displayPath(cwd, path)} (${total} lines total)]`];
	if (merged[0][0] > 1) output.push(`(${merged[0][0] - 1} more lines above)`);
	output.push(merged.map(([start, end]) => lines.slice(start - 1, end).map((line, index) => `${start + index}:${line}`).join("\n")).join("\n\n...\n\n"));
	if (last[1] < total) output.push(`(${total - last[1]} more lines below)`);
	return output.join("\n");
}

async function renderViewed(records: TaskRecord[], cwd: string) {
	const created = new Set(records.flatMap((record) => record.created));
	const viewed = new Map<string, [number, number][]>();
	for (const record of records) {
		for (const [path, ranges] of Object.entries(record.viewed)) {
			if (!created.has(path)) viewed.set(path, [...viewed.get(path) ?? [], ...ranges]);
		}
	}
	const code = (await Promise.all([...viewed].map(([path, ranges]) => renderFile(cwd, path, ranges)))).filter(Boolean).join("\n\n");
	if (!code) return undefined;
	if (viewed.size <= 10 && code.split("\n").length <= 3000 && code.length <= 60_000) {
		return `${PREFIX} During the current session, you have reviewed the following code:\n\n${code}\n\n`
			+ "All displayed code reflects the latest version, incorporating all changes made during the session. Avoid to open displayed parts of the files; use the provided code.";
	}
	return `${PREFIX} During the current session, you have reviewed the following files:\n${[...viewed.keys()].map((path) => displayPath(cwd, path)).join("\n")}`;
}

function renderChanges(records: TaskRecord[]) {
	let blocks = records.flatMap((record) => record.patch?.trim() ? [record.patch.trimEnd().split("\n")
		.map((line) => line.length > 3000 ? `${line.slice(0, 200)} ... [line truncated]` : line).join("\n")] : []);
	if (!blocks.length) return undefined;
	const maxLines = 500;
	const maxChars = 25_000;
	const all = blocks.join(CHANGES_SEPARATOR);
	if (all.split("\n").length > maxLines || all.length > maxChars) {
		// Over the limits Junie keeps at most the five latest blocks that fit, or the start of the latest one.
		const selected: string[] = [];
		let lines = 0;
		let chars = 0;
		for (const block of blocks.toReversed()) {
			if (selected.length >= 5) break;
			const blockLines = block.split("\n");
			if (lines + blockLines.length > maxLines || chars + block.length > maxChars) {
				if (!selected.length) {
					const taken = [];
					let size = 0;
					for (const line of blockLines) {
						if (taken.length >= maxLines || size + line.length > maxChars) break;
						taken.push(line);
						size += line.length + 1;
					}
					selected.push(`${taken.join("\n")}\n\n... [changes truncated]`);
				}
				break;
			}
			lines += blockLines.length;
			chars += block.length;
			selected.push(block);
		}
		blocks = selected.reverse();
	}
	return `${PREFIX} During the current session, you made the following changes in the project's codebase (displayed in git diff format):\n\n${blocks.join(CHANGES_SEPARATOR)}`;
}

/**
 * Like Junie, a retelling is kept per command: records from `newFrom` on came after the previous retelling,
 * so their commands are retold from the latest output and replace the old retelling.
 */
async function renderCommands(records: TaskRecord[], newFrom: number, known: Summaries, summarize?: (commands: Command[]) => Promise<Summaries>) {
	const merged = new Map<string, Command>();
	const rerun = new Set<string>();
	for (const [index, record] of records.entries()) {
		for (const command of record.commands) {
			const count = (merged.get(command.command)?.count ?? 0) + command.count;
			// Re-insert: the latest run supplies the summary and the position.
			merged.delete(command.command);
			merged.set(command.command, { ...command, count });
			if (index >= newFrom) rerun.add(command.command);
		}
	}
	// Carry all earlier retellings forward except the outdated ones, so the latest compaction alone is enough.
	const commandSummaries: Summaries = Object.fromEntries(Object.entries(known).filter(([command]) => !rerun.has(command)));
	let commands = [...merged.values()];
	if (commands.length > 30) {
		const top = commands.slice(0, -10).map((command, index) => ({ command, index }))
			.sort((a, b) => b.command.count - a.command.count || b.index - a.index).slice(0, 20)
			.sort((a, b) => a.command.count - b.command.count || a.index - b.index).map(({ command }) => command);
		commands = [...top, ...commands.slice(-10)];
	}
	const pending = commands.filter((command) => !command.summary && command.output && !commandSummaries[command.command]);
	const fresh = pending.length && summarize ? await summarize(pending).catch((): Summaries => ({})) : {};
	Object.assign(commandSummaries, fresh);
	const lines = commands.map((command) => {
		const retold = command.summary ? undefined : commandSummaries[command.command];
		const summary = singleLine(command.summary ?? retold ?? command.output ?? "") || "(no output)";
		return `\`${command.command}\`${command.count > 1 ? ` (×${command.count})` : ""}: ${summary}`;
	});
	return {
		text: lines.length ? `${PREFIX} During the current session, you executed the following commands:\n\n${lines.join("\n")}` : undefined,
		commandSummaries,
	};
}

function renderRejections(records: TaskRecord[]) {
	const byCommand = new Map<string, string>();
	for (const { command, reason } of records.flatMap((record) => record.rejections)) {
		byCommand.delete(command);
		byCommand.set(command, `- \`${command}\` → ${singleLine(reason)}`);
	}
	if (!byCommand.size) return undefined;
	return `${PREFIX} The user rejected the following commands. Keep obeying these standing instructions and do not run these commands again:\n\n`
		+ [...byCommand.values()].slice(-20).join("\n");
}

/**
 * Build the compaction summary from journal records without the main model, in Junie's block order.
 * `hard` is the on-demand variant: only tasks and rejections, no model call at all.
 */
export async function renderSummary(records: TaskRecord[], options: {
	hard: boolean;
	cwd: string;
	/** Command retellings saved by the previous automatic compaction. */
	known: Summaries;
	/** Index of the first record made after that compaction. */
	newFrom: number;
	summarize?: (commands: Command[]) => Promise<Summaries>;
}) {
	const blocks = [
		`${PREFIX} The current session included prior operations, but the history has been compressed to retain only the essential information and last messages.`,
		renderTasks(records, options.hard),
	];
	let commandSummaries: Summaries = {};
	if (!options.hard) {
		const commands = await renderCommands(records, options.newFrom, options.known, options.summarize);
		commandSummaries = commands.commandSummaries;
		blocks.push(await renderViewed(records, options.cwd), renderChanges(records), commands.text);
	}
	blocks.push(renderRejections(records));
	return { summary: blocks.filter(Boolean).join("\n\n"), commandSummaries };
}

/** Pi's default compaction takes these lists only from a previous compaction of its own, so keep them complete here. */
function fileLists(records: TaskRecord[], cwd: string) {
	const modified = new Set(records.flatMap((record) => [...record.created, ...record.modified ?? []]));
	const read = new Set(records.flatMap((record) => Object.keys(record.viewed)).filter((path) => !modified.has(path)));
	const list = (paths: Set<string>) => [...paths].map((path) => displayPath(cwd, path)).sort();
	return { readFiles: list(read), modifiedFiles: list(modified) };
}

/** One cheap-model request for all commands that have no ready summary; missing lines fall back to raw output. */
async function summarizeCommands(ctx: ExtensionContext, signal: AbortSignal, commands: Command[]) {
	const response = await createSummarizationClient(ctx).complete({
		systemPrompt: "Your task is to summarize the commands and their results.",
		messages: [{
			role: "user", timestamp: Date.now(),
			content: `${COMMANDS_PROMPT}\n\n${commands.map((command) => `<COMMAND>${command.command}</COMMAND>\n<RESPONSE>\n${command.output}\n</RESPONSE>`).join("\n\n")}`,
		}],
	}, { timeoutMs: 30_000, signal, maxTokens: 2048, usageKind: "compaction_summary" });
	const lines = response?.content.flatMap((block) => block.type === "text" ? block.text.split("\n") : []) ?? [];
	const summaries: Summaries = {};
	for (const command of commands) {
		const quoted = `\`${command.command}\``;
		const summary = lines.find((line) => line.trim().startsWith(quoted))?.trim().slice(quoted.length).replace(/^\s*(?:\(×\d+\))?\s*:/, "").trim();
		if (summary) summaries[command.command] = summary;
	}
	return summaries;
}

/**
 * Replace Pi's model-written summary between tasks. Mid-task compaction, overflow retries and any
 * failure return undefined, which leaves Pi's default compaction in charge.
 */
export function createCompactionHandler(collectTail: (ctx: ExtensionContext, entries: SessionEntry[]) => Promise<TaskRecord | undefined>) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult | undefined> => {
		try {
			const entries = event.branchEntries;
			const isAnswer = (entry: SessionEntry) => entry.type === "message" && entry.message.role === "assistant"
				&& !entry.message.content.some((block) => block.type === "toolCall");
			// Pi aborts the run before a manual compaction, so it always counts as between tasks.
			const manual = event.reason === "manual";
			const last = entries.findLast((entry) => entry.type === "message");
			if (!manual && (event.willRetry || !last || !isAnswer(last))) return undefined;
			// The previous automatic Junie compaction: records after it hold commands that it has not retold.
			const previous = entries.findLastIndex((entry) => compactionRetellings(entry));
			const records: TaskRecord[] = [];
			let newFrom = 0;
			for (const [index, entry] of entries.entries()) {
				if (entry.type !== "custom" || entry.customType !== TASK_JOURNAL) continue;
				records.push(entry.data as TaskRecord);
				if (index < previous) newFrom = records.length;
			}
			// Pi checks the threshold before agent_before_settle, so the task that just ended is not journaled yet.
			const tail = await collectTail(ctx, entries);
			if (tail) records.push(tail);
			if (!records.length) return undefined;
			const files = fileLists(records, ctx.cwd);
			if (manual) {
				// Junie's forceCompress: no model call and no verbatim tail except the last answer.
				// Pi does not validate the id, so only move the cut forward within the range Pi itself would keep.
				const answer = entries.findLastIndex(isAnswer);
				const kept = entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
				const { summary } = await renderSummary(records, { hard: true, cwd: ctx.cwd, known: {}, newFrom: 0 });
				// No commandSummaries: the next automatic compaction keeps using the retellings of the previous one.
				return { compaction: {
					summary, firstKeptEntryId: kept >= 0 && answer > kept ? entries[answer].id : event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore, details: files,
				} };
			}
			const known = previous < 0 ? {} : compactionRetellings(entries[previous])!;
			// The cheap request records its own usage entry (COST-14), so the compaction entry carries no usage.
			const { summary, commandSummaries } = await renderSummary(records, {
				hard: false, cwd: ctx.cwd, known, newFrom,
				summarize: (commands) => summarizeCommands(ctx, event.signal, commands),
			});
			if (event.signal.aborted) return undefined;
			return { compaction: {
				summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
				details: { ...files, commandSummaries },
			} };
		} catch {
			return undefined;
		}
	};
}
