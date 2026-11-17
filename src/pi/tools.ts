// Pi tool events -> neutral tool updates (titles, kinds, locations, output text, edit diffs).
// Ported and adapted from pi-acp (MIT, https://github.com/svkozak/pi-acp): toolResultToText, getToolPath,
// getParsedEdits/getEditOldTexts, findUniqueLineNumber, toToolCallLocations, toToolKind, file snapshots.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolKind, ToolUpdate } from "../core/types.ts";

/** Tools the bridge enables in Pi sessions. */
export const BRIDGE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
/** Tools that only read: they run without asking. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function toolKind(name: string): ToolKind {
	switch (name) {
		case "read":
		case "ls":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "grep":
		case "find":
			return "search";
		case "bash":
			return "execute";
		default:
			return "other";
	}
}

export function toolPath(args: unknown): string | undefined {
	const r = args as Record<string, unknown> | undefined;
	if (typeof r?.path === "string") return r.path;
	if (typeof r?.file_path === "string") return r.file_path;
	return undefined;
}

export function toolTitle(name: string, args: unknown): string {
	const r = (args ?? {}) as Record<string, unknown>;
	const path = toolPath(args);
	const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	switch (name) {
		case "read":
			return path ? `Read ${path}` : "Read file";
		case "edit":
			return path ? `Edit ${path}` : "Edit file";
		case "write":
			return path ? `Write ${path}` : "Write file";
		case "ls":
			return `List ${path ?? "."}`;
		case "grep":
			return typeof r.pattern === "string" ? `Search for "${short(r.pattern, 60)}"${path ? ` in ${path}` : ""}` : "Search";
		case "find":
			return typeof r.pattern === "string" ? `Find ${short(r.pattern, 60)}${path ? ` in ${path}` : ""}` : "Find files";
		case "bash":
			return typeof r.command === "string" ? `Run ${short(r.command.split("\n")[0])}` : "Run command";
		default:
			return name;
	}
}

function parsedEdits(args: unknown): { oldText: string; newText: string }[] {
	const r = args as Record<string, unknown> | undefined;
	const out: { oldText: string; newText: string }[] = [];
	if (typeof r?.oldText === "string" && typeof r?.newText === "string") out.push({ oldText: r.oldText, newText: r.newText });
	let edits = r?.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	if (Array.isArray(edits)) {
		for (const e of edits) if (typeof e?.oldText === "string" && typeof e?.newText === "string") out.push({ oldText: e.oldText, newText: e.newText });
	}
	return out;
}

export function uniqueLineNumber(text: string, needle: string): number | undefined {
	if (!needle) return undefined;
	const first = text.indexOf(needle);
	if (first < 0 || text.indexOf(needle, first + needle.length) >= 0) return undefined;
	let line = 1;
	for (let i = 0; i < first; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

export function toolLocations(args: unknown, cwd: string, line?: number): { path: string; line?: number }[] | undefined {
	const path = toolPath(args);
	if (!path) return undefined;
	return [{ path: isAbsolute(path) ? path : resolve(cwd, path), ...(line !== undefined ? { line } : {}) }];
}

/** Readable text of a Pi tool result (content text, else stdout/stderr/exit code). */
export function toolResultText(result: unknown): string {
	if (!result) return "";
	const r = result as Record<string, any>;
	if (Array.isArray(r.content)) {
		const texts = r.content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean);
		if (texts.length) return texts.join("");
	}
	const d = r.details ?? {};
	const stdout = [d.stdout, r.stdout, d.output, r.output].find((v) => typeof v === "string");
	const stderr = [d.stderr, r.stderr].find((v) => typeof v === "string");
	const exit = [d.exitCode, r.exitCode].find((v) => typeof v === "number");
	const parts: string[] = [];
	if (stdout?.trim()) parts.push(stdout);
	if (stderr?.trim()) parts.push(`stderr:\n${stderr}`);
	if (parts.length && exit !== undefined) parts.push(`exit code: ${exit}`);
	if (parts.length) return parts.join("\n\n").trimEnd();
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

/** Tracks one turn's tool calls and turns Pi's events into neutral ToolUpdates. */
export class ToolTracker {
	private readonly cwd: string;
	private readonly snapshots = new Map<string, { path: string; oldText: string | null }>();
	private readonly announced = new Set<string>();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** The model finished writing a tool call (arguments known, not executed yet). */
	requested(id: string, name: string, args: unknown): ToolUpdate | undefined {
		if (this.announced.has(id)) return undefined;
		this.announced.add(id);
		return { id, name, title: toolTitle(name, args), toolKind: toolKind(name), status: "pending", input: args, locations: toolLocations(args, this.cwd) };
	}

	started(id: string, name: string, args: unknown): ToolUpdate {
		this.announced.add(id);
		let line: number | undefined;
		if (name === "edit" || name === "write") {
			const path = toolPath(args);
			if (path) {
				const abs = isAbsolute(path) ? path : resolve(this.cwd, path);
				let oldText: string | null = null;
				try {
					oldText = readFileSync(abs, "utf8");
				} catch {
					// new file
				}
				this.snapshots.set(id, { path: abs, oldText });
				if (oldText && name === "edit") {
					for (const e of parsedEdits(args)) {
						line = uniqueLineNumber(oldText, e.oldText);
						if (line !== undefined) break;
					}
				}
			}
		}
		return { id, name, title: toolTitle(name, args), toolKind: toolKind(name), status: "in_progress", input: args, locations: toolLocations(args, this.cwd, line) };
	}

	progressed(id: string, name: string, partial: unknown): ToolUpdate | undefined {
		if (this.snapshots.has(id)) return undefined; // file mutations report a diff at the end
		const output = toolResultText(partial);
		return output ? { id, name, status: "in_progress", output } : undefined;
	}

	finished(id: string, name: string, result: unknown, isError: boolean): ToolUpdate {
		const snapshot = this.snapshots.get(id);
		this.snapshots.delete(id);
		const status = isError ? "failed" : "completed";
		if (snapshot && !isError) {
			try {
				const newText = readFileSync(snapshot.path, "utf8");
				if (newText !== snapshot.oldText) return { id, name, status, diff: { path: snapshot.path, oldText: snapshot.oldText, newText } };
			} catch {
				// fall through to text
			}
		}
		return { id, name, status, output: toolResultText(result) };
	}
}
