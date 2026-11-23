/**
 * Junie's settings as Junie reads them: one environment variable each, the value as given, else the default.
 *
 * Names, environment variables and defaults mirror Junie's sources (junie-agent f38ae6e44c, 2026-11-22):
 * - `ej-core/.../agent/util/EjProperties.kt:28–87` (the agent settings that Junie records in `agent_configuration`);
 * - `ej-app/cli-standalone/.../utils/Environment.kt` (task, model, credentials, home);
 * - resolution as `DefaultMatterhornPropertyProvider` (`core/.../settings/MatterhornProperties.kt`): an environment
 *   variable that is set wins, even when empty; otherwise the default; otherwise unset.
 *
 * This module only reads. What each setting does in Pi is decided where it is applied (see the package README).
 */

export interface JunieSetting {
	/** Junie's property name, as in `agent_configuration` (e.g. `model_mix_enabled`); for CLI-only settings the env name in lower case. */
	name: string;
	env: string;
	default?: string;
	/** Credentials: never logged or recorded, only whether they are set. */
	secret?: true;
}

const s = (name: string, env: string, extra: Partial<JunieSetting> = {}): JunieSetting => ({ name, env, ...extra });

export const JUNIE_SETTINGS: readonly JunieSetting[] = [
	// EjProperties: model and request
	s("primary_model", "PRIMARY_MODEL"), // Junie's default is its primary model (primaryLlm), not a fixed id
	s("primary_model_prompt_cache_enabled", "PRIMARY_MODEL_PROMPT_CACHE_ENABLED", { default: "true" }),
	s("primary_model_temperature", "PRIMARY_MODEL_TEMPERATURE"),
	s("primary_model_max_tokens", "PRIMARY_MODEL_MAX_TOKENS"),
	s("primary_model_thinking_budget", "PRIMARY_MODEL_THINKING_BUDGET"),
	s("primary_model_reasoning_effort", "PRIMARY_MODEL_REASONING_EFFORT"),
	s("primary_model_text_verbosity", "PRIMARY_MODEL_TEXT_VERBOSITY"),
	s("primary_model_task_budget", "PRIMARY_MODEL_TASK_BUDGET"),
	s("primary_historyProcessor", "PRIMARY_HISTORY_PROCESSOR"),
	s("primary_max_command_output_line_length", "PRIMARY_MAX_COMMAND_OUTPUT_LINE_LENGTH"),
	s("primary_max_command_output_lines", "PRIMARY_MAX_COMMAND_OUTPUT_LINES"),
	s("primary_model_num_choices", "PRIMARY_MODEL_NUM_CHOICES"),
	s("primary_critique", "PRIMARY_CRITIQUE"),
	s("primary_use_demo", "PRIMARY_USE_DEMO"),
	s("primary_use_tools_mode", "PRIMARY_USE_TOOLS_MODE"),
	s("primary_use_tools", "PRIMARY_USE_TOOLS", { default: "true" }),
	s("primary_model_include_encrypted_content", "PRIMARY_MODEL_INCLUDE_ENCRYPTED_CONTENT", { default: "true" }),
	s("primary_model_parallel_tool_calls", "PRIMARY_MODEL_PARALLEL_TOOL_CALLS"),
	// EjProperties: agent behavior
	s("model_mix_enabled", "MODEL_MIX_ENABLED"),
	s("max_steps", "MAX_STEPS"),
	s("demo_max_steps", "DEMO_MAX_STEPS", { default: "400" }),
	s("allow_call_expert", "ALLOW_CALL_EXPERT"),
	s("add_project_str", "ADD_PROJECT_STR"),
	s("web_search_mode", "WEB_SEARCH_MODE", { default: "tool" }),
	s("fetch_url_enabled", "FETCH_URL_ENABLED", { default: "true" }),
	s("force_mermaid_graphs", "FORCE_MERMAID_GRAPHS", { default: "false" }),
	s("verify_project", "VERIFY_PROJECT"),
	s("junie_execution_mode", "JUNIE_EXECUTION_MODE"),
	s("external_thought_enabled", "EXTERNAL_THOUGHT_ENABLED"),
	s("update_status_frequency", "UPDATE_STATUS_FREQUENCY"),
	s("is_standalone", "IS_STANDALONE"),
	s("supports_ask_question", "SUPPORTS_ASK_QUESTION"),
	s("subagents_mode", "SUBAGENTS_MODE", { default: "Auto" }),
	s("subagents_enabled", "SUBAGENTS_ENABLED"),
	s("chat_repository_observation", "CHAT_REPOSITORY_OBSERVATION", { default: "true" }),
	s("junie_guidelines", "JUNIE_GUIDELINES"),
	s("junie_ide_guidelines", "JUNIE_IDE_GUIDELINES"),
	s("benchmark_rules", "JUNIE_BENCHMARK_RULES"),
	s("junie_stop_hook_block_cap", "JUNIE_STOP_HOOK_BLOCK_CAP", { default: "8" }),
	// Environment.kt: task, model choice, home
	s("ej_task", "EJ_TASK"),
	s("junie_task", "JUNIE_TASK"),
	s("junie_model", "JUNIE_MODEL"),
	s("junie_llm_provider", "JUNIE_LLM_PROVIDER"),
	s("junie_effort", "JUNIE_EFFORT"),
	s("junie_home", "JUNIE_HOME"),
	s("junie_time_limit", "JUNIE_TIME_LIMIT"),
	s("ej_auth_use_direct_access", "EJ_AUTH_USE_DIRECT_ACCESS"),
	s("junie_litellm_url", "JUNIE_LITELLM_URL"),
	// Environment.kt: credentials
	s("junie_api_key", "JUNIE_API_KEY", { secret: true }),
	s("junie_anthropic_api_key", "JUNIE_ANTHROPIC_API_KEY", { secret: true }),
	s("junie_openai_api_key", "JUNIE_OPENAI_API_KEY", { secret: true }),
	s("junie_grok_api_key", "JUNIE_GROK_API_KEY", { secret: true }),
	s("junie_google_api_key", "JUNIE_GOOGLE_API_KEY", { secret: true }),
	s("junie_meta_api_key", "JUNIE_META_API_KEY", { secret: true }),
	s("junie_openrouter_api_key", "JUNIE_OPENROUTER_API_KEY", { secret: true }),
	s("junie_litellm_api_key", "JUNIE_LITELLM_API_KEY", { secret: true }),
];

export interface ResolvedSetting {
	setting: JunieSetting;
	value: string;
	/** `env` when the environment set it, `default` when Junie's default applies. */
	source: "env" | "default";
}

/** Every setting that has a value, in table order. */
export function resolveJunieSettings(env: Readonly<Record<string, string | undefined>> = process.env): ResolvedSetting[] {
	return JUNIE_SETTINGS.flatMap((setting): ResolvedSetting[] => {
		const fromEnv = env[setting.env];
		if (fromEnv !== undefined) return [{ setting, value: fromEnv, source: "env" }];
		return setting.default !== undefined ? [{ setting, value: setting.default, source: "default" }] : [];
	});
}

export const SECRET_PLACEHOLDER = "<set>";

/**
 * The record of a run's configuration, like Junie's `agent_configuration`: every resolved value by property name,
 * credentials as `<set>`. `fromEnv` lists the names the environment set.
 */
export function configurationRecord(resolved: readonly ResolvedSetting[]): { settings: Record<string, string>; fromEnv: string[] } {
	return {
		settings: Object.fromEntries(resolved.map((r) => [r.setting.name, r.setting.secret ? SECRET_PLACEHOLDER : r.value])),
		fromEnv: resolved.filter((r) => r.source === "env").map((r) => r.setting.name),
	};
}

/** One log line: the settings the environment set, credentials masked; undefined when none is set. */
export function describeJunieSettings(resolved: readonly ResolvedSetting[]): string | undefined {
	const set = resolved.filter((r) => r.source === "env");
	if (set.length === 0) return undefined;
	const show = (v: string) => (v.length > 60 ? `${JSON.stringify(v.slice(0, 57))}...` : JSON.stringify(v));
	return set.map((r) => `${r.setting.env}=${r.setting.secret ? SECRET_PLACEHOLDER : show(r.value)}`).join(" ");
}
