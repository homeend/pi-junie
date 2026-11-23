/**
 * Junie's behavior settings for Pi (plan step 4), resolved from the environment as Junie resolves them
 * (`ej-core/.../agent/util/EjProperties.kt` setupFromEnvironment, junie-agent f38ae6e44c).
 *
 * - `MAX_STEPS`: Junie's agent stops after this many steps (one model request with its tool calls; a Pi turn) and
 *   exits with `ExitMaxIter`. Junie's default is 150 outside interactive mode and 50 (75/100 for some models)
 *   interactively, where it asks whether to continue. Here: the variable's number; else 150 when
 *   `JUNIE_EXECUTION_MODE` is set to a non-interactive mode; else no limit (an interactive chat in AIR is not cut).
 * - `ADD_PROJECT_STR=true`: Junie adds the project's root listing (`ProjectStrNode`, StandaloneProjectStructureWorker).
 *   Only the exact value `true` enables it, as in Junie.
 * - `SUBAGENTS_ENABLED=false`, `WEB_SEARCH_MODE=disabled|no|false|off`, `FETCH_URL_ENABLED=false` turn tools off.
 * - Request options: `PRIMARY_MODEL_TEMPERATURE`, `PRIMARY_MODEL_MAX_TOKENS`, `PRIMARY_MODEL_PARALLEL_TOOL_CALLS`,
 *   `PRIMARY_MODEL_PROMPT_CACHE_ENABLED` (request-options.ts).
 */
import { existsSync, readdirSync, statSync } from "node:fs";

type Env = Readonly<Record<string, string | undefined>>;

export interface JunieBehavior {
	maxSteps?: number;
	addProjectStructure: boolean;
	/** Tool names to keep inactive. */
	disabledTools: string[];
	request: RequestSettings;
}

export interface RequestSettings {
	temperature?: number;
	maxTokens?: number;
	parallelToolCalls?: boolean;
	promptCache?: boolean;
}

/** Tools of the plugins pi-junie loads (subagents, web access), by Junie's switch that turns them off. */
const SUBAGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];
const WEB_SEARCH_TOOLS = ["web_search", "source_check"];
const FETCH_TOOLS = ["fetch_content", "get_search_content"];

const NON_INTERACTIVE_MAX_STEPS = 150;

const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v: string | undefined) => (v === undefined ? undefined : v.trim().toLowerCase() === "true");

export function junieBehavior(env: Env = process.env): JunieBehavior {
	const mode = env.JUNIE_EXECUTION_MODE?.trim();
	const steps = num(env.MAX_STEPS);
	const maxSteps = steps !== undefined && steps > 0 ? Math.floor(steps) : mode && mode !== "Interactive" ? NON_INTERACTIVE_MAX_STEPS : undefined;
	const webSearch = env.WEB_SEARCH_MODE?.trim().toLowerCase();
	const disabledTools = [
		...(bool(env.SUBAGENTS_ENABLED) === false ? SUBAGENT_TOOLS : []),
		...(webSearch && ["disabled", "no", "false", "off"].includes(webSearch) ? WEB_SEARCH_TOOLS : []),
		...(bool(env.FETCH_URL_ENABLED) === false ? FETCH_TOOLS : []),
	];
	const maxTokens = num(env.PRIMARY_MODEL_MAX_TOKENS);
	const request: RequestSettings = {
		...(num(env.PRIMARY_MODEL_TEMPERATURE) !== undefined ? { temperature: num(env.PRIMARY_MODEL_TEMPERATURE) } : {}),
		...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {}),
		...(env.PRIMARY_MODEL_PARALLEL_TOOL_CALLS !== undefined ? { parallelToolCalls: bool(env.PRIMARY_MODEL_PARALLEL_TOOL_CALLS) } : {}),
		...(env.PRIMARY_MODEL_PROMPT_CACHE_ENABLED !== undefined ? { promptCache: bool(env.PRIMARY_MODEL_PROMPT_CACHE_ENABLED) } : {}),
	};
	return { ...(maxSteps ? { maxSteps } : {}), addProjectStructure: env.ADD_PROJECT_STR === "true", disabledTools, request };
}

/** Junie's settings this package or pi-junie applies; the others are recorded but have no effect in Pi. */
export const APPLIED_SETTINGS = new Set([
	"PRIMARY_MODEL",
	"PRIMARY_MODEL_REASONING_EFFORT",
	"PRIMARY_MODEL_TEMPERATURE",
	"PRIMARY_MODEL_MAX_TOKENS",
	"PRIMARY_MODEL_PARALLEL_TOOL_CALLS",
	"PRIMARY_MODEL_PROMPT_CACHE_ENABLED",
	"MAX_STEPS",
	"ADD_PROJECT_STR",
	"WEB_SEARCH_MODE",
	"FETCH_URL_ENABLED",
	"SUBAGENTS_ENABLED",
	"JUNIE_EXECUTION_MODE",
	"JUNIE_BENCHMARK_RULES", // Junie Cost appends it to the task
	"JUNIE_MODEL",
	"JUNIE_EFFORT",
	"JUNIE_HOME",
	"JUNIE_LOG_PROMPT_USAGE",
	"JUNIE_API_KEY",
	"JUNIE_ANTHROPIC_API_KEY",
	"JUNIE_OPENAI_API_KEY",
	"JUNIE_GOOGLE_API_KEY",
]);

// Junie's StandaloneProjectStructureWorker / ProjectStructureUtil / ProjectStrNode / ProjectStrResponse.
const DIRECTORIES_TO_SKIP = ["__pycache__", "build", "packages", "venv", "env", "site-packages"];
const MAX_ONE_PATH_LEN = 200;

/** Junie's `## PROJECT STRUCTURE` text for the root directory, or undefined when it cannot be listed. */
export function projectStructure(root: string): string | undefined {
	if (!existsSync(root) || !statSync(root).isDirectory()) return undefined;
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return undefined;
	}
	const listed = names
		.filter((n) => !n.startsWith(".") && !(DIRECTORIES_TO_SKIP.includes(n) && !n.includes(".")))
		.filter((n) => n.length <= MAX_ONE_PATH_LEN)
		.sort();
	const paths = listed.length ? listed.join("\n") : "No entries have been found.";
	const description = "Below are the files and directories in the project's root directory (`ls`).";
	return `## PROJECT STRUCTURE\nProject root directory: ${root}\n${description}\n\n${paths}\n\nDon't run the \`ls\` command for the project's root directory. Instead, use the information provided above.`;
}

