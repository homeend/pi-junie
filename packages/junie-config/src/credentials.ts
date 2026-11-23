/**
 * Junie's credentials and model choice from the environment (plan step 2), as plain data for whoever runs Pi.
 *
 * Credentials as Junie's CLI reads them (`ej-app/cli-standalone/.../utils/Environment.kt`): `JUNIE_API_KEY` (JetBrains
 * AI through Ingrazzio) and one key per vendor. A blank value counts as unset. Vendors without a counterpart in Pi
 * here (Grok, Meta, OpenRouter, LiteLLM) are reported, not used.
 *
 * The model: `JUNIE_MODEL` (the CLI option) before `PRIMARY_MODEL` (the agent property), both Junie model ids such as
 * `claude-opus-5-5`; the effort: `JUNIE_EFFORT` before `PRIMARY_MODEL_REASONING_EFFORT`, Junie effort ids (`none`, `low`,
 * `medium`, `high`, `xhigh`, ...).
 */

export type Vendor = "anthropic" | "openai" | "google";

export interface JunieCredentials {
	junieApiKey?: string;
	vendorKeys: { vendor: Vendor; env: string; apiKey: string }[];
	/** Credential variables that are set but have no use here yet. */
	unsupported: string[];
}

const VENDOR_KEYS: { vendor: Vendor; env: string }[] = [
	{ vendor: "anthropic", env: "JUNIE_ANTHROPIC_API_KEY" },
	{ vendor: "openai", env: "JUNIE_OPENAI_API_KEY" },
	{ vendor: "google", env: "JUNIE_GOOGLE_API_KEY" },
];
const UNSUPPORTED_KEYS = ["JUNIE_GROK_API_KEY", "JUNIE_META_API_KEY", "JUNIE_OPENROUTER_API_KEY", "JUNIE_LITELLM_API_KEY"];

type Env = Readonly<Record<string, string | undefined>>;
const value = (env: Env, name: string) => env[name]?.trim() || undefined;

export function junieCredentials(env: Env = process.env): JunieCredentials {
	const junieApiKey = value(env, "JUNIE_API_KEY");
	return {
		...(junieApiKey ? { junieApiKey } : {}),
		vendorKeys: VENDOR_KEYS.flatMap(({ vendor, env: name }) => {
			const apiKey = value(env, name);
			return apiKey ? [{ vendor, env: name, apiKey }] : [];
		}),
		unsupported: UNSUPPORTED_KEYS.filter((name) => value(env, name)),
	};
}

export interface JunieModelChoice {
	/** Junie's model id. */
	model?: string;
	/** Junie's effort id, lower case. */
	effort?: string;
}

export function junieModelChoice(env: Env = process.env): JunieModelChoice {
	const model = value(env, "JUNIE_MODEL") ?? value(env, "PRIMARY_MODEL");
	const effort = (value(env, "JUNIE_EFFORT") ?? value(env, "PRIMARY_MODEL_REASONING_EFFORT"))?.toLowerCase();
	return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
