import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { JUNIE_API_KEY_ENV, junieApiKeyToAuth } from "./api-key.ts";
import { type OAuthCallbackServer, startOAuthCallbackServer } from "./callback-server.ts";

const CLIENT_ID = "junie-cli";
const REDIRECT_URI = "https://account.jetbrains.com/oauth2/ide/callback";
const TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token";

async function exchange(parameters: URLSearchParams, signal: AbortSignal, refresh?: string): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, { method: "POST", body: parameters, signal });
	if (!response.ok) throw new Error(`JetBrains token exchange failed (HTTP ${response.status})`);
	const data: unknown = await response.json();
	if (
		typeof data !== "object" ||
		data === null ||
		!("id_token" in data) ||
		typeof data.id_token !== "string" ||
		!("expires_in" in data) ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0
	) {
		throw new Error("Invalid JetBrains token response");
	}
	const refreshToken =
		"refresh_token" in data && typeof data.refresh_token === "string" ? data.refresh_token : refresh;
	if (!refreshToken || !data.id_token) throw new Error("JetBrains token response is missing tokens");
	return {
		type: "oauth",
		access: data.id_token,
		refresh: refreshToken,
		expires: Date.now() + data.expires_in * 1000 - 60_000,
	};
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

export const jetbrainsAiOAuth: OAuthAuth = {
	name: "JetBrains",
	isSubscription: true,
	async login(interaction) {
		interaction.signal.throwIfAborted();
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
		);
		const state = crypto.randomUUID();
		let callback: OAuthCallbackServer<OAuthCredential> | undefined;
		for (let port = 62345; port <= 62364; port++) {
			try {
				callback = await startOAuthCallbackServer({
					providerName: "JetBrains",
					host: "localhost",
					port,
					path: "/",
					state,
					signal: interaction.signal,
					timeoutMs: 300_000,
					complete: (code) =>
						exchange(
							new URLSearchParams({
								grant_type: "authorization_code",
								code,
								redirect_uri: `http://localhost:${port}`,
								client_id: CLIENT_ID,
								code_verifier: verifier,
							}),
							interaction.signal,
						),
				});
				break;
			} catch (error) {
				interaction.signal.throwIfAborted();
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
			}
		}
		try {
			const parameters = new URLSearchParams({
				client_id: CLIENT_ID,
				scope: "offline_access openid jb-authn-service",
				state,
				code_challenge: challenge,
				// Junie's registered callback uses localhost with no trailing slash.
				redirect_uri: callback ? callback.redirectUri.replace(/\/$/, "") : REDIRECT_URI,
			});
			interaction.notify({
				type: "auth_url",
				url: `https://junie.jetbrains.com/cli-auth?${parameters}`,
				instructions: callback
					? "Sign in in your browser. Pi will receive the callback automatically."
					: "Local login ports are occupied. Paste the authorization code shown by JetBrains.",
			});
			if (callback) {
				const credential = await callback.wait();
				if (!credential) throw new Error("JetBrains login cancelled");
				return credential;
			}
			const input = (
				await interaction.prompt({ type: "manual_code", message: "JetBrains authorization code" })
			).trim();
			let code = input;
			try {
				const decoded: unknown = JSON.parse(atob(input));
				if (
					typeof decoded === "object" &&
					decoded !== null &&
					"code" in decoded &&
					typeof decoded.code === "string"
				)
					code = decoded.code;
			} catch {
				// JetBrains also accepts a raw authorization code.
			}
			if (!code) throw new Error("Missing JetBrains authorization code");
			return await exchange(
				new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: REDIRECT_URI,
					client_id: CLIENT_ID,
					code_verifier: verifier,
				}),
				interaction.signal,
			);
		} finally {
			callback?.close();
		}
	},
	refresh(credential, signal) {
		return exchange(
			new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: credential.refresh,
				client_id: CLIENT_ID,
			}),
			signal,
			credential.refresh,
		);
	},
	async toAuth(credential) {
		// Like Junie, JUNIE_API_KEY takes precedence over the saved browser login.
		const key = process.env[JUNIE_API_KEY_ENV]?.trim();
		if (key) return junieApiKeyToAuth(key);
		return { apiKey: credential.access, headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
