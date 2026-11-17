// Fixed provider slots offered to the client. Which models a slot offers is discovered from the bound proxy
// (discovery.ts); Pi's built-in catalog supplies the metadata (API quirks, reasoning, limits).

import type { Api } from "@earendil-works/pi-ai";

export interface SlotDefinition {
	id: string;
	displayName: string;
	/**
	 * client apiType -> how Pi talks to it: Pi API, Pi catalog provider for model metadata, and the path
	 * Pi's client needs appended to AIR's baseUrl. AIR's convention (AirLlmGatewayRoutes): anthropic = API root
	 * (SDK adds /v1/messages), openai = already the /v1 base, google = API root (agent adds /v1beta).
	 */
	apiTypes: Record<string, { piApi: Api; catalogProvider: string; basePath: string }>;
}

export const SLOTS: SlotDefinition[] = [
	{
		id: "anthropic",
		displayName: "Anthropic",
		apiTypes: { anthropic: { piApi: "anthropic-messages", catalogProvider: "anthropic", basePath: "" } },
	},
	{
		id: "openai",
		displayName: "OpenAI",
		apiTypes: { openai: { piApi: "openai-responses", catalogProvider: "openai", basePath: "" } },
	},
	{
		id: "google",
		displayName: "Google",
		apiTypes: {
			google: { piApi: "google-generative-ai", catalogProvider: "google", basePath: "/v1beta" },
			vertex: { piApi: "google-vertex", catalogProvider: "google-vertex", basePath: "" }, // experimental
		},
	},
];

/** Preferred default when a session has not picked a model (falls back to the first available). */
export const DEFAULT_MODEL = { slotId: "anthropic", modelId: "claude-sonnet-5-5" };

/** Name of the Pi provider that carries a client binding. Never one of Pi's own providers. */
export function bridgeProviderId(slotId: string): string {
	return `air-${slotId}`;
}

export function joinBaseUrl(baseUrl: string, basePath: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return basePath && !trimmed.endsWith(basePath) ? `${trimmed}${basePath}` : trimmed;
}
