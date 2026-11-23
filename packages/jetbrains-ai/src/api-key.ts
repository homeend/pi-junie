import type { ApiKeyAuth, ModelAuth } from "@earendil-works/pi-ai";

export const JUNIE_API_KEY_ENV = "JUNIE_API_KEY";

/** Mirrors Junie: GitHub tokens use the `GitHub` scheme, Junie API keys are Bearer tokens. */
export function junieApiKeyToAuth(key: string): ModelAuth {
	const scheme = key.startsWith("ghp_") || key.startsWith("github_pat_") ? "GitHub" : "Bearer";
	return { apiKey: key, headers: { Authorization: `${scheme} ${key}` } };
}

/** Junie API key from https://junie.jetbrains.com/cli, either stored via `/login` or read from `JUNIE_API_KEY`. */
export const jetbrainsAiApiKey: ApiKeyAuth = {
	name: "Junie API key",
	async login(interaction) {
		interaction.signal.throwIfAborted();
		const key = (await interaction.prompt({ type: "secret", message: "Enter Junie API key" })).trim();
		interaction.signal.throwIfAborted();
		if (!key) throw new Error("Missing Junie API key");
		return { type: "api_key", key };
	},
	async resolve({ ctx, credential, signal }) {
		signal.throwIfAborted();
		if (credential?.key) return { auth: junieApiKeyToAuth(credential.key), source: "stored credential" };
		const key = (await ctx.env(JUNIE_API_KEY_ENV))?.trim();
		signal.throwIfAborted();
		return key ? { auth: junieApiKeyToAuth(key), source: JUNIE_API_KEY_ENV } : undefined;
	},
};
