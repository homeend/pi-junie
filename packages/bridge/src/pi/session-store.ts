import type { ApprovalMode } from "../core/types.ts";
// Persists bridge sessions so they survive agent restarts (AIR restarts the agent whenever the proxy identity
// changes and then calls session/resume). Two files per session under <stateDir>/sessions:
//   <id>.json        our metadata (cwd, selected model, timestamps)
//   pi/<...>.jsonl   Pi's own transcript (SessionManager, created with the same id)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "../core/types.ts";

export interface SessionMeta {
	id: string;
	cwd: string;
	model?: ModelRef;
	title?: string;
	effort?: string;
	/** The Default group level in use (its model and effort are in `model` and `effort`). */
	mix?: string;
	/** Brave Mode: safe / auto / brave. */
	approvalMode?: ApprovalMode;
	/** Eco mode as chosen in this session for its explicit model (else the remembered choice for the model). */
	eco?: boolean;
	/** Plan mode as the user last chose it (applied to the plan-mode plugin at the next prompt). */
	planMode?: boolean;
	lastPromptAt?: string;
	/** The session this one was forked from. */
	forkedFrom?: string;
	createdAt: string;
	updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export class SessionStore {
	readonly dir: string;
	readonly piDir: string;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "sessions");
		this.piDir = join(this.dir, "pi");
		mkdirSync(this.piDir, { recursive: true });
	}

	static isValidId(id: string): boolean {
		return SAFE_ID.test(id) && id !== "." && id !== "..";
	}

	save(meta: SessionMeta): void {
		writeFileSync(this.metaPath(meta.id), `${JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2)}\n`);
	}

	load(id: string): SessionMeta | undefined {
		if (!SessionStore.isValidId(id)) return undefined;
		const path = this.metaPath(id);
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as SessionMeta;
	}

	/** All saved sessions (unreadable files are skipped), newest first. */
	list(): SessionMeta[] {
		const metas: SessionMeta[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				metas.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as SessionMeta);
			} catch {
				// a half-written or foreign file: ignore
			}
		}
		return metas.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	}

	/** Pi's transcript for this session: reopened if it exists, otherwise a new file-backed session with the same id. */
	piSessionManager(id: string, cwd: string): { manager: SessionManager; restored: boolean } {
		const existing = SessionManager.findById(cwd, id, this.piDir);
		if (existing) return { manager: SessionManager.open(existing, this.piDir, cwd), restored: true };
		return { manager: SessionManager.create(cwd, this.piDir, { id }), restored: false };
	}

	/**
	 * Copies a session's Pi transcript into a new session `id` working in `cwd` (Pi's `forkFrom`: same entries, a new
	 * header with that cwd and the source as parent). False when the source has no transcript yet (nothing to copy).
	 */
	forkTranscript(source: { id: string; cwd: string }, id: string, cwd: string): boolean {
		const path = SessionManager.findById(source.cwd, source.id, this.piDir) ?? this.findTranscript(source.id);
		if (!path) return false;
		SessionManager.forkFrom(path, cwd, this.piDir, { id });
		return true;
	}

	/** The transcript file of a session, whatever cwd its header names (a session resumed elsewhere). */
	private findTranscript(id: string): string | undefined {
		for (const name of readdirSync(this.piDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(this.piDir, name);
			try {
				const header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]) as { type?: string; id?: string };
				if (header.type === "session" && header.id === id) return path;
			} catch {
				// unreadable: not ours
			}
		}
		return undefined;
	}

	private metaPath(id: string): string {
		if (!SessionStore.isValidId(id)) throw new Error(`invalid session id ${id}`);
		return join(this.dir, `${id}.json`);
	}
}

/** Opens an existing Pi transcript read-only, or undefined when the session never prompted. */
export function openPiTranscript(store: SessionStore, id: string, cwd: string): SessionManager | undefined {
	const existing = SessionManager.findById(cwd, id, store.piDir);
	return existing ? SessionManager.open(existing, store.piDir, cwd) : undefined;
}
