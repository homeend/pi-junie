/**
 * Request options Junie applies to the body of every request (plan steps 3 and 4).
 *
 * A custom model profile's `extraBody` is merged into the top level of the request JSON and wins over fields already
 * set, and its `temperature` is sent when declared (documentation/topics/Custom-LLM-models.md, "Extra body" and
 * "Temperature"). Google's API takes the temperature in `generationConfig`.
 */
import type { RequestSettings } from "./behavior.ts";
import { mergeBody, type ProfileModel } from "./profiles.ts";

export function withProfileOptions(payload: unknown, model: ProfileModel): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	let body = { ...(payload as Record<string, unknown>) };
	if (model.temperature !== undefined) body = withTemperature(body, model.apiType === "Google", model.temperature);
	return model.extraBody ? mergeBody(body, model.extraBody) : body;
}

export function withTemperature(body: Record<string, unknown>, google: boolean, temperature: number): Record<string, unknown> {
	if (!google) return { ...body, temperature };
	const config = typeof body.generationConfig === "object" && body.generationConfig !== null ? body.generationConfig : {};
	return { ...body, generationConfig: { ...config, temperature } };
}

/**
 * Junie's request settings for the session's model (`PRIMARY_MODEL_*`, see behavior.ts), in each API's own field.
 * A profile's own temperature wins over PRIMARY_MODEL_TEMPERATURE (Junie uses the profile's for custom models), so
 * the caller applies the profile options after these.
 */
export function withRequestSettings(payload: unknown, api: string, settings: RequestSettings): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	let body: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
	const google = api === "google-generative-ai" || api === "google-vertex";
	const anthropic = api === "anthropic-messages";
	if (settings.temperature !== undefined) body = withTemperature(body, google, settings.temperature);
	if (settings.maxTokens !== undefined) {
		if (google) body = { ...body, generationConfig: { ...((body.generationConfig as object) ?? {}), maxOutputTokens: settings.maxTokens } };
		else if (anthropic) body.max_tokens = settings.maxTokens;
		else if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") body.max_output_tokens = settings.maxTokens;
		else body["max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens"] = settings.maxTokens;
	}
	const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
	if (settings.parallelToolCalls === false && hasTools) {
		if (anthropic) body.tool_choice = { ...((body.tool_choice as object) ?? { type: "auto" }), disable_parallel_tool_use: true };
		else if (!google) body.parallel_tool_calls = false;
	}
	if (settings.promptCache === false) {
		if (anthropic) body = withoutCacheControl(body) as Record<string, unknown>;
		else {
			delete body.prompt_cache_key;
			delete body.prompt_cache_retention;
		}
	}
	return body;
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, withoutCacheControl(v)]));
}
