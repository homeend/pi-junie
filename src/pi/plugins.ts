// Pi plugins (pi packages) the bridge knows how to use. The user installs them with Pi itself
// (`pi install npm:<name>`); the bridge only detects them in the user's Pi agent dir and loads them into its
// sessions by path. Bridge sessions otherwise load no extensions from disk (isolated agent dir).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../core/log.ts";

/** Subagents: in-process child Pi sessions (`Agent` tool), https://github.com/tintinweb/pi-subagents */
export const SUBAGENTS_PLUGIN = "@tintinweb/pi-subagents";
/** Tools the subagents plugin registers that bridge sessions enable (workflows stay off for now). */
export const SUBAGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

const KNOWN_PLUGINS = [SUBAGENTS_PLUGIN];

export interface DetectedPlugin {
	name: string;
	version?: string;
	/** Package directory, loadable as a Pi extension source. */
	path: string;
}

/**
 * Known plugins installed in the user's Pi agent dir. Looks where `pi install npm:<name>` puts packages
 * (`<agentDir>/npm/node_modules/<name>`).
 */
export function detectPlugins(piAgentDir: string, log?: Logger): DetectedPlugin[] {
	const found: DetectedPlugin[] = [];
	for (const name of KNOWN_PLUGINS) {
		const path = join(piAgentDir, "npm", "node_modules", name);
		const manifest = join(path, "package.json");
		if (!existsSync(manifest)) {
			log?.info(`plugin ${name} not installed (install with: pi install npm:${name})`);
			continue;
		}
		let version: string | undefined;
		try {
			const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
			if (typeof pkg.version === "string") version = pkg.version;
		} catch (err) {
			log?.warn(`plugin ${name}: unreadable package.json (${(err as Error).message})`);
		}
		log?.info(`plugin ${name} ${version ?? "<unknown version>"} found at ${path}`);
		found.push({ name, version, path });
	}
	return found;
}
