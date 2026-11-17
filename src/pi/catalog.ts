// Fixed provider slots offered to the client, and the curated models per slot.
// Like Junie, the agent decides which providers/models exist; the client only binds endpoints to slots.
// Model metadata (context window, pricing, reasoning) is taken from Pi's built-in catalog.

import type { Api } from "@earendil-works/pi-ai";

export interface SlotDefinition {
	id: string;
	displayName: string;
	/**
	 * client apiType -> how Pi talks to it: Pi API, Pi catalog provider for model metadata, and the path
	 * Pi's client expects at the end of baseUrl (AIR sends bare proxy roots; Pi's built-in providers
	 * carry the version path in baseUrl, e.g. https://api.openai.com/v1).
	 */
	apiTypes: Record<string, { piApi: Api; catalogProvider: string; basePath: string }>;
	models: string[];
}

export const SLOTS: SlotDefinition[] = [
	{
		id: "anthropic",
		displayName: "Anthropic",
		apiTypes: { anthropic: { piApi: "anthropic-messages", catalogProvider: "anthropic", basePath: "" } },
		models: ["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"],
	},
	{
		id: "openai",
		displayName: "OpenAI",
		apiTypes: { openai: { piApi: "openai-responses", catalogProvider: "openai", basePath: "/v1" } },
		models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	},
	{
		id: "google",
		displayName: "Google",
		apiTypes: {
			google: { piApi: "google-generative-ai", catalogProvider: "google", basePath: "/v1beta" },
			vertex: { piApi: "google-vertex", catalogProvider: "google-vertex", basePath: "" }, // experimental
		},
		models: ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
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
