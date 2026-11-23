import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { jetbrainsAiApiKey } from "./api-key.ts";
import { jetbrainsAiOAuth } from "./oauth.ts";
import { JETBRAINS_AI_MODELS } from "./models.ts";
import { jetbrainsStreams } from "./streams.ts";

/** Uses Junie's public PKCE login and Ingrazzio's upstream-compatible Responses route. */
export function jetbrainsAiProvider(): Provider {
	return createProvider({
		id: "jetbrains-ai",
		name: "JetBrains",
		baseUrl: "https://ingrazzio-cloud-prod.labs.jb.gg/v1",
		headers: { "X-Keep-Path": "true" },
		auth: { apiKey: jetbrainsAiApiKey, oauth: jetbrainsAiOAuth },
		models: JETBRAINS_AI_MODELS,
		api: {
			"openai-responses": jetbrainsStreams(openAIResponsesApi()),
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": jetbrainsStreams(anthropicMessagesApi()),
			"google-generative-ai": googleGenerativeAIApi(),
		},
	});
}
