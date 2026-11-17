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
	/** Plan mode as the user last chose it (applied to the plan-mode plugin at the next prompt). */
	planMode?: boolean;
	lastPromptAt?: string;
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
