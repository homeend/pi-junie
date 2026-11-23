// JetBrains' Ingrazzio API, reached through the route the client gives for the `ingrazzio` provider slot (like the
// model providers: a proxy URL plus headers from `providers/set`). Junie asks for this slot and reads its remote
// feature flags there: `GET <route>/api/feature-flags/<channel>` (junie-agent RemoteFeatureFlags.kt), among them the
// `JUNIE_MIXES` catalog behind its Default model group and `ECO_MODE_IMPLEMENTATION`. The bridge fetches the same
// flags and offers Junie Lite through the route (Ingrazzio forwards each request to the vendor named in a header).

import type { Logger } from "../core/log.ts";
import type { ProviderBinding } from "../core/types.ts";

export const INGRAZZIO_SLOT = { id: "ingrazzio", displayName: "JetBrains AI", apiType: "ingrazzio" };

/** Junie's channel for stable builds ("eap" otherwise). */
const CHANNEL = "ga";
const TIMEOUT_MS = 5000;

/** The flags we read; the response holds more. */
export const FLAG_JUNIE_MIXES = "JUNIE_MIXES";
export const FLAG_ECO_MODE_IMPLEMENTATION = "ECO_MODE_IMPLEMENTATION";

export type FeatureFlags = { kind: "loaded"; values: Record<string, unknown> } | { kind: "failed"; reason: string };

export function featureFlagsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/api/feature-flags/${CHANNEL}`;
}

/** Loads the feature flags through the binding's route (the client's proxy adds the account's auth). */
export async function loadFeatureFlags(binding: ProviderBinding, options: { fetch?: typeof fetch; log: Logger }): Promise<FeatureFlags> {
	const url = featureFlagsUrl(binding.baseUrl);
	const started = Date.now();
	try {
		const response = await (options.fetch ?? fetch)(url, { headers: binding.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
		const took = Date.now() - started;
		const text = await response.text();
		if (!response.ok) {
			options.log.warn(`ingrazzio: feature flags HTTP ${response.status} after ${took}ms at ${url}: ${text.slice(0, 300)}`);
			return { kind: "failed", reason: `HTTP ${response.status}` };
		}
		const body = JSON.parse(text) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			options.log.warn(`ingrazzio: feature flags at ${url} are not a JSON object: ${text.slice(0, 300)}`);
			return { kind: "failed", reason: "not a JSON object" };
		}
		const values = body as Record<string, unknown>;
		options.log.info(`ingrazzio: feature flags loaded after ${took}ms from ${url}: keys [${Object.keys(values).join(", ")}]`);
		for (const flag of [FLAG_JUNIE_MIXES, FLAG_ECO_MODE_IMPLEMENTATION]) {
			options.log.info(`ingrazzio: ${flag} = ${values[flag] === undefined ? "<absent>" : JSON.stringify(values[flag])}`);
		}
		return { kind: "loaded", values };
	} catch (err) {
		const reason = (err as Error)?.message ?? String(err);
		options.log.warn(`ingrazzio: feature flags FAILED after ${Date.now() - started}ms at ${url}: ${reason}`);
		return { kind: "failed", reason };
	}
}

/**
 * Junie Lite (Junie's free model, the Default group's Lite level): Qwen3.6 27B on JetBrains' AI platform vLLM, reached
 * like Junie does (junie-agent IngrazzioLLMAccess.kt, LLMAccess.defaultPathForRequest, IngrazzioLicenseHeaders.kt):
 * OpenAI chat completions at `<route>/llm/vllm/v1/chat/completions`, vendor `jbai`, path kept, forced free license.
 * Ingrazzio has no listing for vLLM, so the model is offered without discovery (Junie does the same).
 */
export const JUNIE_LITE = {
	/** The id on the wire (Junie's `LLM.QWEN3_6_27B_AI_PLATFORM.name`). */
	id: "Qwen/Qwen3.6-27B-FP8",
	/** Junie's setting id, used by its Default group catalog. */
	settingId: "junie-lite",
	name: "Junie Lite",
};

const JUNIE_LITE_HEADERS: Record<string, string> = {
	"X-LLM-Model": "jbai",
	"X-Keep-Path": "true",
	"X-Forced-License-Free": "true",
	"X-Accept-EAP-License": "false",
	"X-Accept-Release-License": "false",
};

/** Pi provider config for the models served through the Ingrazzio route (Junie Lite). */
export function ingrazzioProvider(binding: ProviderBinding, apiKey: string) {
	return {
		name: "AIR JetBrains AI",
		baseUrl: `${binding.baseUrl.replace(/\/+$/, "")}/llm/vllm/v1`,
		headers: { ...binding.headers, ...JUNIE_LITE_HEADERS },
		apiKey,
		api: "openai-completions" as const,
		models: [
			{
				id: JUNIE_LITE.id,
				name: JUNIE_LITE.name,
				api: "openai-completions" as const,
				// Junie runs it without effort (EffortLevel: None only).
				reasoning: false,
				input: ["text" as const, "image" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262_144,
				maxTokens: 32_768,
				compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" as const },
			},
		],
	};
}
