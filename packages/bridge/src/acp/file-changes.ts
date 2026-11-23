// AIR's per-turn changed-files report (`agentFileChangeReport`, Junie's
// `acp/session/changedfiles/AgentFileChangeReportMeta.kt`, AIR spec structured-agent-session "Turn file-change reports"):
// AIR asks on a prompt (`session/prompt._meta.jetbrains.air.agentFileChangeReportRequest = {version: 1, requestId}`),
// the agent answers before the prompt's response with a `session_info_update` whose `_meta` holds the turn's changed
// paths. AIR shows the "N files changed · Since last turn" card and the Last Turn diff from it.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { SessionUpdate } from "./wire.ts";

export const AGENT_FILE_CHANGE_REPORT = "agentFileChangeReport";
const VERSION = 1;
const MAX_PATHS = 1024;
const MAX_PATH_BYTES = 256 * 1024;
/** Junie's note: only the edit tools' changes are tracked (shell commands and others may change files too). */
const UNCERTAINTY = "Non-edit writes and transient create/delete paths may be missing.";

/** The prompt's report request id: exactly `{version: 1, requestId}` under `_meta.jetbrains.air`, as Junie accepts it. */
export function decodeFileChangeReportRequest(meta: unknown): string | undefined {
	const request = (meta as { jetbrains?: { air?: { agentFileChangeReportRequest?: unknown } } } | undefined)?.jetbrains?.air?.agentFileChangeReportRequest;
	if (typeof request !== "object" || request === null) return undefined;
	const r = request as Record<string, unknown>;
	if (Object.keys(r).sort().join() !== "requestId,version" || r.version !== VERSION) return undefined;
	return typeof r.requestId === "string" && r.requestId.trim() ? r.requestId : undefined;
}

/** The real path when the file or folder exists (symlinks resolved), else the absolute path. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The report for a turn: the changed paths that lie inside the session's folders, canonical, without repeats, within
 * AIR's limits (1,024 paths, 256 KiB). `declaredComplete` is false, as in Junie.
 */
export function encodeFileChangeReport(requestId: string, changedPaths: readonly string[], roots: readonly string[]): SessionUpdate {
	const canonicalRoots = [...new Set(roots.map(canonical))];
	const inside = (p: string) => canonicalRoots.some((root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep));
	const paths: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (const p of [...new Set(changedPaths.map(canonical))].filter(inside)) {
		const size = Buffer.byteLength(p, "utf8");
		if (paths.length >= MAX_PATHS || bytes + size > MAX_PATH_BYTES) {
			truncated = true;
			break;
		}
		paths.push(p);
		bytes += size;
	}
	return {
		sessionUpdate: "session_info_update",
		_meta: {
			jetbrains: {
				air: {
					version: VERSION,
					[AGENT_FILE_CHANGE_REPORT]: { version: VERSION, requestId, status: "reported", paths, declaredComplete: false, truncated, uncertainty: UNCERTAINTY },
				},
			},
		},
	};
}
