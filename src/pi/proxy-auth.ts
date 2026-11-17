// The AIR proxy authenticates the agent through the providers/set headers (`x-air-proxy-key`, ...) and injects
// the real credentials upstream. Junie sends no vendor auth header over ACP. Pi's SDK clients insist on an API
// key, so the bridge registers a placeholder and this fetch wrapper removes it again before a request leaves.

export const PLACEHOLDER_API_KEY = "air-proxy";

/** Vendor auth headers the SDKs fill from the API key (Anthropic, OpenAI, Google/Vertex, Azure). */
const VENDOR_AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

/** Wraps fetch so vendor auth headers carrying the placeholder key are dropped; real keys pass untouched. */
export function withoutPlaceholderAuth(fetchImpl: typeof fetch): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		let changed = false;
		for (const name of VENDOR_AUTH_HEADERS) {
			const value = headers.get(name);
			if (value !== null && value.replace(/^Bearer\s+/i, "").trim() === PLACEHOLDER_API_KEY) {
				headers.delete(name);
				changed = true;
			}
		}
		return changed ? fetchImpl(input, { ...init, headers }) : fetchImpl(input, init);
	};
}
