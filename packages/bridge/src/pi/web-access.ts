// Web access from the pi-web-access plugin: web search, page/PDF/GitHub fetching, stored results, claim checks.
//
// The bridge enables the plugin's four tools directly and leaves out its `web_enable` loader, so the model always has
// them (the plugin then keeps the tool set as Pi started it). Searching and reading stored results run without asking;
// fetching asks in Safe mode, since it can clone repositories with the user's `gh` login and read local video files.
// The plugin's TUI commands (/websearch, /curator, /search) are not offered: they need Pi's terminal UI.

export const WEB_ACCESS_PLUGIN = "pi-web-access";
export const WEB_SEARCH_TOOL = "web_search";
export const SOURCE_CHECK_TOOL = "source_check";
export const FETCH_CONTENT_TOOL = "fetch_content";
export const STORED_CONTENT_TOOL = "get_search_content";
/** The plugin's tools (default names) that bridge sessions enable. */
export const WEB_ACCESS_TOOLS = [WEB_SEARCH_TOOL, SOURCE_CHECK_TOOL, FETCH_CONTENT_TOOL, STORED_CONTENT_TOOL];
/** Run without asking: they only send queries out and read the plugin's own result cache. */
export const WEB_READ_TOOLS = [WEB_SEARCH_TOOL, SOURCE_CHECK_TOOL, STORED_CONTENT_TOOL];

/**
 * Turns off `web_search`'s background page fetch (`includeContent`). When that fetch finishes the plugin starts a new
 * agent run by itself, possibly after the turn ended, where no client would see it; the model fetches pages with
 * `fetch_content` instead. Changes the call's input in place.
 */
export function withoutBackgroundFetch(toolName: string, input: Record<string, unknown>): void {
	if (toolName === WEB_SEARCH_TOOL && input.includeContent !== undefined && input.includeContent !== false) input.includeContent = false;
}

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function strings(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()) : [];
}

/** Row titles of the plugin's tools; undefined for other tools. */
export function webToolTitle(name: string, args: Record<string, unknown>): string | undefined {
	switch (name) {
		case WEB_SEARCH_TOOL: {
			const queries = [...strings(args.query), ...strings(args.queries)];
			return queries.length ? `Search the web: ${short(queries.map((q) => `"${q}"`).join(", "))}` : "Search the web";
		}
		case SOURCE_CHECK_TOOL:
			return typeof args.claim === "string" && args.claim.trim() ? `Check claim: "${short(args.claim.trim(), 70)}"` : "Check claim";
		case FETCH_CONTENT_TOOL: {
			const urls = [...strings(args.url), ...strings(args.urls)];
			return urls.length === 1 ? `Fetch ${short(urls[0]!)}` : urls.length ? `Fetch ${urls.length} URLs` : "Fetch";
		}
		case STORED_CONTENT_TOOL:
			return typeof args.url === "string" && args.url.trim() ? `Read stored result: ${short(args.url.trim(), 70)}` : "Read stored web result";
		default:
			return undefined;
	}
}
