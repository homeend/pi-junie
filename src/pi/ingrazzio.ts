// JetBrains' Ingrazzio API, reached through the route the client gives for the `ingrazzio` provider slot (like the
// model providers: a proxy URL plus headers from `providers/set`). Junie asks for this slot and reads its remote
// feature flags there: `GET <route>/api/feature-flags/<channel>` (junie-agent RemoteFeatureFlags.kt), among them the
// `JUNIE_MIXES` catalog behind its Default model group and `ECO_MODE_IMPLEMENTATION`. The bridge fetches the same
// flags. The slot serves no models.

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
