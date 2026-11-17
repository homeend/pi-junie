// Turns Pi's error texts into neutral TurnFailures (category, safe title, details, recovery), like Junie's
// session failure presentation. No ACP here.

import type { TurnFailure } from "../core/types.ts";

const MAX_DETAILS = 2000;

/** Classifies a failed turn. `overflow` is Pi's own context-overflow verdict for the failed message. */
export function classifyFailure(message: string, options: { overflow?: boolean } = {}): TurnFailure {
	const details = cleanDetails(message);
	if (options.overflow) return { category: "limit", title: "The context window is full", details, actions: ["new_session"] };
	const status = httpStatus(message);
	if (status === 401 || status === 403) return { category: "access", title: `Access denied by the model provider (${status})`, details, actions: [] };
	if (status === 404) return { category: "request", title: "The model provider does not know this model or endpoint (404)", details, actions: [] };
	if (status === 408 || status === 504) return { category: "connection", title: "The model did not respond in time", details, actions: ["retry"] };
	// No retry: an immediate retry walks straight back into the same limit (Junie does the same).
	if (status === 429) return { category: "service", title: "The model provider is rate limiting requests", details, actions: [] };
	if (status !== undefined && status >= 500) return { category: "service", title: `The model provider is temporarily unavailable (${status})`, details, actions: ["retry"] };
	if (status !== undefined && status >= 400) return { category: "request", title: `The model provider rejected the request (${status})`, details, actions: [] };
	if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|network/i.test(message)) {
		return { category: "connection", title: "Could not reach the model provider", details, actions: ["retry"] };
	}
	if (/overloaded/i.test(message)) return { category: "service", title: "The model provider is overloaded", details, actions: ["retry"] };
	return { category: "unknown", title: "The run stopped", details, actions: ["retry"] };
}

/** HTTP status in Pi/SDK error texts: `404 Not Found`, `"code":404`, `status code 429`, ... */
function httpStatus(message: string): number | undefined {
	const match = /"code"\s*:\s*(\d{3})\b/.exec(message) ?? /\b(?:status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(message) ?? /^\s*(\d{3})\b/.exec(message);
	const code = match ? Number(match[1]) : undefined;
	return code !== undefined && code >= 400 && code < 600 ? code : undefined;
}

/** The provider's message for the details line: JSON error bodies reduced to their message, bounded. */
function cleanDetails(message: string): string | undefined {
	let text = message.trim();
	try {
		const parsed = JSON.parse(text) as { error?: { message?: unknown; status?: unknown } };
		const inner = parsed?.error;
		if (inner) text = [inner.message, inner.status].filter((v) => typeof v === "string" && v).join(" — ");
	} catch {
		// not JSON
	}
	if (!text) return undefined;
	return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS - 1)}…` : text;
}
