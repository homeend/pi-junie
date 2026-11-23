// Fixed provider slots offered to the client. Which models a slot offers is discovered from the bound proxy
// (discovery.ts); Pi's built-in catalog supplies the metadata (API quirks, reasoning, limits).

import type { Api } from "@earendil-works/pi-ai";

export interface PickerModel {
	id: string;
	name: string;
	/**
	 * For a model Pi's catalog does not know yet: describe it as this Pi model (same family and capabilities in
	 * Junie's ModelParameters.kt) with Junie's prices, USD per million tokens. Remove once Pi knows the model.
	 */
	like?: { model: string; cost: { input: number; output: number; cacheRead: number } };
}

export interface SlotDefinition {
	id: string;
	displayName: string;
	/**
	 * Models the picker may show for this slot, in picker order: Junie's non-deprecated `ModelOption.Specific`
	 * entries (junie-agent core/.../llm/ModelParameters.kt). This is what the AIR infrastructure backs; a
	 * vendor listing is intersected with it. An account catalog (`/models/user`) is authoritative instead.
	 */
	picker: PickerModel[];
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
		picker: [
			{ id: "claude-fable-5-2", name: "Claude Fable 5.2" },
			{ id: "claude-fable-5-1", name: "Claude Fable 5.1" },
			{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
			{ id: "claude-opus-5", name: "Claude Opus 5" },
			{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
			{ id: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
		],
	},
	{
		id: "openai",
		displayName: "OpenAI",
		apiTypes: { openai: { piApi: "openai-responses", catalogProvider: "openai", basePath: "" } },
		picker: [
			{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
			{ id: "gpt-6-sol", name: "GPT-6 Sol" },
			{ id: "gpt-6-astra", name: "GPT-6 Astra" },
			{ id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
			{ id: "gpt-6-luna", name: "GPT-6 Luna" },
			{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
			{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
			{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
		],
	},
	{
		id: "google",
		displayName: "Google",
		apiTypes: {
			google: { piApi: "google-generative-ai", catalogProvider: "google", basePath: "/v1beta" },
			vertex: { piApi: "google-vertex", catalogProvider: "google-vertex", basePath: "" }, // experimental
		},
		picker: [
			// Pi 1.5.2 lacks these; Junie: same capabilities as gemini-4-argon (1M context, vision), own prices.
			{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", like: { model: "gemini-4-argon", cost: { input: 1.5, output: 7.5, cacheRead: 0.075 } } },
			{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", like: { model: "gemini-4-argon", cost: { input: 2.0, output: 10.0, cacheRead: 0.1 } } },
			{ id: "gemini-4-argon", name: "Gemini 4 Argon" },
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			{ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
		],
	},
];

/** Preferred default when a session has not picked a model (falls back to the first available). */
export const DEFAULT_MODEL = { slotId: "anthropic", modelId: "claude-sonnet-5-5" };

/** Name of the Pi provider that carries a client binding. Never one of Pi's own providers. */
export function bridgeProviderId(slotId: string): string {
	return slotId === JETBRAINS_AI_GROUP.id ? JETBRAINS_AI_GROUP.providerId : `air-${slotId}`;
}

/**
 * JetBrains AI with a Junie API key (`JUNIE_API_KEY`): Junie's model catalog through Ingrazzio, from the copied
 * jetbrains-ai package (packages/jetbrains-ai). A model group of its own; the provider keeps the package's id.
 */
export const JETBRAINS_AI_GROUP = { id: "jetbrains-ai", displayName: "JetBrains AI", providerId: "jetbrains-ai" };

/**
 * Where a vendor key (`JUNIE_<VENDOR>_API_KEY`) binds the vendor's slot: the vendor's public API, in the same form a
 * client binding has (slot apiType and base URL, see SlotDefinition.apiTypes).
 */
export const VENDOR_ROUTES: Record<string, { apiType: string; baseUrl: string }> = {
	anthropic: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" },
	openai: { apiType: "openai", baseUrl: "https://api.openai.com/v1" },
	google: { apiType: "google", baseUrl: "https://generativelanguage.googleapis.com" },
};

/** The vendor's own auth header for a real key, for requests the bridge makes itself (model discovery). */
export function keyAuthHeaders(apiType: string, apiKey: string): Record<string, string> {
	if (apiType === "anthropic") return { "x-api-key": apiKey };
	if (apiType === "google") return { "x-goog-api-key": apiKey };
	return { authorization: `Bearer ${apiKey}` };
}

/** Junie's placeholders when the client names no Vertex project/location; the proxy fills in the real ones. */
export const VERTEX_PLACEHOLDER = { projectId: "default-project", location: "default-location" };

/**
 * Request base for a vertex binding: `base/v1/projects/{p}/locations/{l}`, the path Junie uses through the proxy.
 * Pi's Vertex client then appends `/publishers/google/models/...` (it treats a base with an API version as complete);
 * without it Pi would use express mode (`base/v1/publishers/...`), which the JetBrains proxy answers with 404.
 */
export function vertexBaseUrl(baseUrl: string, location = VERTEX_PLACEHOLDER): string {
	return `${baseUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(location.projectId)}/locations/${encodeURIComponent(location.location)}`;
}

export function joinBaseUrl(baseUrl: string, basePath: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return basePath && !trimmed.endsWith(basePath) ? `${trimmed}${basePath}` : trimmed;
}
