// Pi plugins (pi packages) the bridge knows how to use. The user installs them with Pi itself
// (`pi install npm:<name>`); the bridge only detects them in the user's Pi agent dir and loads them into its
// sessions by path. Bridge sessions otherwise load no extensions from disk (isolated agent dir).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../core/log.ts";
import { PLAN_MODE_PLUGIN, PLAN_MODE_TOOLS } from "./plan-mode.ts";
import { WEB_ACCESS_PLUGIN, WEB_ACCESS_TOOLS } from "./web-access.ts";

/** Subagents: in-process child Pi sessions (`Agent` tool), https://github.com/tintinweb/pi-subagents */
export const SUBAGENTS_PLUGIN = "@tintinweb/pi-subagents";
/** Tools the subagents plugin registers that bridge sessions enable (workflows stay off for now). */
export const SUBAGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

/** Todo list (`todo` tool), shown as the session's plan: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo */
export const TODO_PLUGIN = "@juicesharp/rpiv-todo";
/** Tools the todo plugin registers. */
export const TODO_TOOLS = ["todo"];

/** Plan mode (read-only planning, then a reviewed plan): https://www.npmjs.com/package/@narumitw/pi-plan-mode */
export { PLAN_MODE_PLUGIN } from "./plan-mode.ts";

/** Web search and fetching (`web_search`, `fetch_content`, ...): https://github.com/nicobailon/pi-web-access */
export { WEB_ACCESS_PLUGIN } from "./web-access.ts";

const KNOWN_PLUGINS = [SUBAGENTS_PLUGIN, TODO_PLUGIN, PLAN_MODE_PLUGIN, WEB_ACCESS_PLUGIN];

/** Tools of the detected plugins that bridge sessions enable. */
export function pluginTools(detected: DetectedPlugin[]): string[] {
	return [
		...(has(detected, SUBAGENTS_PLUGIN) ? SUBAGENT_TOOLS : []),
		...(has(detected, TODO_PLUGIN) ? TODO_TOOLS : []),
		...(has(detected, PLAN_MODE_PLUGIN) ? PLAN_MODE_TOOLS : []),
		...(has(detected, WEB_ACCESS_PLUGIN) ? WEB_ACCESS_TOOLS : []),
	];
}

export function has(detected: DetectedPlugin[], name: string): boolean {
	return detected.some((p) => p.name === name);
}

/** Welcome lines about the plugins (Markdown list items). */
export function pluginWelcomeLines(detected: DetectedPlugin[]): string[] {
	const line = (label: string, name: string) => {
		const plugin = detected.find((p) => p.name === name);
		return plugin
			? `- **${label}: available** (\`${name}\` ${plugin.version ?? "unknown version"})`
			: `- **${label}: not available** (install with \`pi install npm:${name}\`, then restart the agent)`;
	};
	return [line("Subagents", SUBAGENTS_PLUGIN), line("Todo list", TODO_PLUGIN), line("Plan mode", PLAN_MODE_PLUGIN), line("Web access", WEB_ACCESS_PLUGIN)];
}

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
			log?.info(`plugin ${name} not installed in ${piAgentDir} (install with: pi install npm:${name})`);
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
