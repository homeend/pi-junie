// Pi plugins (pi packages) the bridge knows how to use. The user installs them with Pi itself
// (`pi install npm:<name>`); the bridge only detects them in the user's Pi agent dir and loads them into its
// sessions by path. Bridge sessions otherwise load no extensions from disk (isolated agent dir).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

/**
 * Junie Cost (Junie's cost savings for Pi: tool-output limits and summaries, cache-aware history thinning, task-journal
 * compaction, accounted cheap-model requests, bash timeout guidance). Not on npm: installed from a local checkout of
 * the junie-pi repository with `pi install <path>/packages/junie-cost`. Registers no tools the bridge enables; its Eco
 * mode needs Pi's `jetbrains-ai` provider, which bridge sessions do not have, so Eco stays inert.
 */
export const JUNIE_COST_PLUGIN = "pi-extension-junie-cost";

const KNOWN_PLUGINS = [SUBAGENTS_PLUGIN, TODO_PLUGIN, PLAN_MODE_PLUGIN, WEB_ACCESS_PLUGIN, JUNIE_COST_PLUGIN];

/** How the welcome message tells the user to install a plugin that is missing. */
const INSTALL_HINT: Record<string, string> = {
	[JUNIE_COST_PLUGIN]: "install from a junie-pi checkout with `pi install <junie-pi>/packages/junie-cost`",
};

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
			: `- **${label}: not available** (${INSTALL_HINT[name] ?? `install with \`pi install npm:${name}\``}, then restart the agent)`;
	};
	return [
		line("Subagents", SUBAGENTS_PLUGIN),
		line("Todo list", TODO_PLUGIN),
		line("Plan mode", PLAN_MODE_PLUGIN),
		line("Web access", WEB_ACCESS_PLUGIN),
		line("Junie Cost", JUNIE_COST_PLUGIN),
	];
}

export interface DetectedPlugin {
	name: string;
	version?: string;
	/** Package directory, loadable as a Pi extension source. */
	path: string;
}

/**
 * Known plugins installed in the user's Pi agent dir. Looks where `pi install npm:<name>` puts packages
 * (`<agentDir>/npm/node_modules/<name>`) and at the local packages `pi install <path>` lists in the agent dir's
 * `settings.json` (`packages`, relative to the agent dir), matched by their package.json name.
 */
export function detectPlugins(piAgentDir: string, log?: Logger): DetectedPlugin[] {
	const local = localPackages(piAgentDir, log);
	const found: DetectedPlugin[] = [];
	for (const name of KNOWN_PLUGINS) {
		const npmPath = join(piAgentDir, "npm", "node_modules", name);
		const path = existsSync(join(npmPath, "package.json")) ? npmPath : local.get(name);
		if (!path) {
			log?.info(`plugin ${name} not installed in ${piAgentDir} (${INSTALL_HINT[name] ?? `install with: pi install npm:${name}`})`);
			continue;
		}
		const version = readManifest(path, log)?.version;
		log?.info(`plugin ${name} ${version ?? "<unknown version>"} found at ${path}`);
		found.push({ name, version, path });
	}
	return found;
}

function readManifest(dir: string, log?: Logger): { name?: string; version?: string } | undefined {
	const manifest = join(dir, "package.json");
	if (!existsSync(manifest)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
		return { name: typeof pkg.name === "string" ? pkg.name : undefined, version: typeof pkg.version === "string" ? pkg.version : undefined };
	} catch (err) {
		log?.warn(`plugin at ${dir}: unreadable package.json (${(err as Error).message})`);
		return undefined;
	}
}

/** Local package directories from the agent dir's settings.json, by package name. */
function localPackages(piAgentDir: string, log?: Logger): Map<string, string> {
	const out = new Map<string, string>();
	const settingsFile = join(piAgentDir, "settings.json");
	if (!existsSync(settingsFile)) return out;
	let packages: unknown;
	try {
		packages = (JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown }).packages;
	} catch (err) {
		log?.warn(`plugins: unreadable ${settingsFile} (${(err as Error).message})`);
		return out;
	}
	if (!Array.isArray(packages)) return out;
	for (const entry of packages) {
		// An entry is a source string or {source, ...filters}; npm: and git sources live elsewhere.
		const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
		if (typeof source !== "string" || /^(npm|git|https?|ssh):/.test(source) || source.startsWith("git@")) continue;
		const expanded = source === "~" || source.startsWith("~/") ? join(homedir(), source.slice(1)) : source;
		const dir = isAbsolute(expanded) ? expanded : resolve(piAgentDir, expanded);
		const name = readManifest(dir, log)?.name;
		if (name && !out.has(name)) out.set(name, dir);
	}
	return out;
}
