/**
 * A Junie custom model profile as a Pi provider (plan step 3): one provider per profile, offering its primary model.
 *
 * - API: OpenAICompletion -> openai-completions, OpenAIResponses -> openai-responses, Anthropic -> anthropic-messages,
 *   Google -> google-generative-ai.
 * - Junie's `baseUrl` is the full endpoint (`.../v1/chat/completions`); Pi's clients append the endpoint path
 *   themselves, so that suffix is removed (`/chat/completions`, `/responses`, `/v1/messages`, `/models/...`).
 * - Efforts: Junie's effort names become Pi thinking levels whose provider value is the declared name. Standard names
 *   keep their level (`none` = off); custom names (`turbo`, `deep`) take the free levels from low upwards. Without
 *   efforts the model has no reasoning (Junie: only `none`).
 * - `extraBody` and `temperature` are applied per request by the junie-config extension (request-options.ts).
 * - Junie sends no Authorization header without `apiKey`: the provider then gets the caller's placeholder key, which
 *   pi-junie strips from requests (packages/bridge/src/pi/proxy-auth.ts).
 */
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ApiType, JunieProfile, ProfileModel } from "./profiles.ts";

export const PROFILE_PROVIDER_PREFIX = "junie-custom-";

/** Junie's model id of a profile, also the bridge's model group (slot) id. */
export const profileModelId = (profileId: string) => `custom:${profileId}`;
export const profileProviderId = (profileId: string) => `${PROFILE_PROVIDER_PREFIX}${profileId}`;

const PI_API: Record<ApiType, "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai"> = {
	OpenAICompletion: "openai-completions",
	OpenAIResponses: "openai-responses",
	Anthropic: "anthropic-messages",
	Google: "google-generative-ai",
};

const ENDPOINT_SUFFIX: Record<ApiType, RegExp> = {
	OpenAICompletion: /\/chat\/completions\/?$/,
	OpenAIResponses: /\/responses\/?$/,
	Anthropic: /\/v1\/messages\/?$/,
	Google: /\/models\/[^/]+$/,
};

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const STANDARD_LEVEL: Record<string, Level> = { none: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const FREE_LEVEL_ORDER: Level[] = ["low", "medium", "high", "xhigh", "max", "minimal"];

/** Junie effort name -> Pi level, for the declared efforts. */
export function effortLevels(efforts: string[] | undefined): Map<string, Level> {
	const out = new Map<string, Level>();
	if (!efforts) return out;
	for (const e of efforts) {
		const level = STANDARD_LEVEL[e.toLowerCase()];
		if (level) out.set(e, level);
	}
	for (const e of efforts) {
		if (out.has(e)) continue;
		const free = FREE_LEVEL_ORDER.find((l) => ![...out.values()].includes(l));
		if (free) out.set(e, free);
	}
	return out;
}

export function endpointBase(model: ProfileModel): string {
	return model.baseUrl.replace(ENDPOINT_SUFFIX[model.apiType], "");
}

export interface ProfileProvider {
	providerId: string;
	/** The model's Pi thinking level for the profile's default effort, if any. */
	defaultLevel?: Level;
	config: ProviderConfig;
}

export function profileProvider(profile: JunieProfile, placeholderApiKey: string): ProfileProvider {
	const m = profile.primary;
	const api = PI_API[m.apiType];
	const levels = effortLevels(m.efforts);
	const reasoning = [...levels.values()].some((l) => l !== "off");
	const allLevels: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const thinkingLevelMap: Partial<Record<Level, string | null>> | undefined = reasoning
		? Object.fromEntries(allLevels.map((l) => [l, [...levels].find(([, v]) => v === l)?.[0] ?? (l === "off" ? undefined : null)]).filter(([, v]) => v !== undefined))
		: undefined;
	const contextWindow = m.maxContextLength ?? 128_000;
	const defaultLevel = m.defaultEffort ? levels.get(m.defaultEffort) : undefined;
	return {
		providerId: profileProviderId(profile.profileId),
		...(defaultLevel ? { defaultLevel } : {}),
		config: {
			name: profile.displayName,
			baseUrl: endpointBase(m),
			headers: m.headers,
			apiKey: m.apiKey ?? placeholderApiKey,
			api,
			models: [
				{
					id: m.id,
					name: profile.providerName ? `${profile.displayName} (${profile.providerName})` : profile.displayName,
					api,
					reasoning,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: Math.min(32_768, contextWindow),
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				},
			],
		},
	};
}
