// Proxy model discovery: asks AIR's proxy which models this binding may use (an ACL decided by the
// account/key), mirroring Junie's AcpProxyModelDiscovery / ModelListingClient. See docs/junie-proxy-triage.md §4.1.
// Pure HTTP + parsing; matching against Pi's catalog happens in backend.ts.

import type { Logger } from "../core/log.ts";

export interface ListedModel {
	/** Id exactly as the proxy lists it; sent as `model` on the wire. */
	id: string;
	displayName?: string;
	description?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	inputModalities?: string[];
	/** USD per million tokens. */
	pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export type DiscoveryResult =
	| { kind: "listed"; source: "account" | "vendor"; url: string; models: ListedModel[] }
	| { kind: "failed"; url: string; reason: string };

export interface DiscoveryRequest {
	apiType: string;
	/** baseUrl exactly as AIR sent it in providers/set (before any Pi-specific path). */
	baseUrl: string;
	headers: Record<string, string>;
}

export interface DiscoveryOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
	log?: Logger;
}

interface VendorRoute {
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	/** Returns ids/records of one page and the query for the next page, if any. */
	parse(body: any): { models: ListedModel[]; next?: Record<string, string> };
}

const MAX_PAGES = 20;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

const openAiList: VendorRoute["parse"] = (body) => ({ models: requireArray(body?.data, "data").map((r: any) => ({ id: String(r.id) })) });

const VENDOR_ROUTES: Record<string, VendorRoute> = {
	openai: { path: "/models", parse: openAiList },
	anthropic: {
		path: "/v1/models",
		query: { limit: "1000" },
		headers: { "anthropic-version": "2023-06-01" },
		parse: (body) => ({
			models: requireArray(body?.data, "data").map((r: any) => ({ id: String(r.id), displayName: r.display_name ?? undefined })),
			next: body?.has_more === true && body?.last_id ? { limit: "1000", after_id: String(body.last_id) } : undefined,
		}),
	},
	google: {
		path: "/v1beta/models",
		parse: (body) => ({
			models: requireArray(body?.models, "models").map((r: any) => ({ id: String(r.name).split("/").pop() as string, displayName: r.displayName ?? undefined })),
			next: body?.nextPageToken ? { pageToken: String(body.nextPageToken) } : undefined,
		}),
	},
	vertex: {
		path: "/v1beta1/publishers/google/models",
		parse: (body) => ({
			models: requireArray(body?.publisherModels, "publisherModels").map((r: any) => ({ id: (String(r.name).split("/").pop() as string).split("@")[0] })),
			next: body?.nextPageToken ? { pageToken: String(body.nextPageToken) } : undefined,
		}),
	},
};

/** apiTypes with a JetBrains account catalog (`GET base/models/user`). */
const ACCOUNT_CATALOG_API_TYPES = new Set(["openai", "anthropic"]);

export async function discoverModels(request: DiscoveryRequest, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
	const base = request.baseUrl.replace(/\/+$/, "");
	const log = options.log;

	if (ACCOUNT_CATALOG_API_TYPES.has(request.apiType)) {
		const url = `${base}/models/user`;
		try {
			const res = await getJson(doFetch, url, request.headers, timeoutMs);
			if (res.status === 404) {
				log?.info(`discovery ${request.apiType}: account catalog not supported (404), using vendor listing`);
			} else if (!res.ok) {
				return { kind: "failed", url, reason: `account catalog HTTP ${res.status}: ${res.text.slice(0, 300)}` };
			} else {
				return { kind: "listed", source: "account", url, models: parseAccountCatalog(res.json) };
			}
		} catch (err) {
			return { kind: "failed", url, reason: `account catalog: ${(err as Error).message}` };
		}
	}

	const route = VENDOR_ROUTES[request.apiType];
	if (!route) return { kind: "failed", url: base, reason: `no model listing for apiType ${request.apiType}` };
	const url = `${base}${route.path}`;
	const models: ListedModel[] = [];
	let query = route.query;
	try {
		for (let page = 0; page < MAX_PAGES; page++) {
			const pageUrl = query ? `${url}?${new URLSearchParams(query)}` : url;
			const res = await getJson(doFetch, pageUrl, { ...route.headers, ...request.headers }, timeoutMs);
			if (!res.ok) return { kind: "failed", url, reason: `HTTP ${res.status}: ${res.text.slice(0, 300)}` };
			const parsed = route.parse(res.json);
			models.push(...parsed.models);
			if (!parsed.next) return { kind: "listed", source: "vendor", url, models: dedupe(models) };
			query = parsed.next;
		}
		log?.warn(`discovery ${request.apiType}: more than ${MAX_PAGES} pages, using what was read`);
		return { kind: "listed", source: "vendor", url, models: dedupe(models) };
	} catch (err) {
		return { kind: "failed", url, reason: (err as Error).message };
	}
}

/** `{ data: [{ id, name, description, context_length, architecture, pricing (per token), top_provider }] }` */
export function parseAccountCatalog(body: any): ListedModel[] {
	return dedupe(
		requireArray(body?.data, "data").flatMap((r: any): ListedModel[] => {
			if (typeof r?.id !== "string" || !r.id) throw new Error("account catalog record without id");
			const outputs: unknown = r.architecture?.output_modalities;
			if (Array.isArray(outputs) && !outputs.includes("text")) return [];
			const perMillion = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1_000_000 : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) * 1_000_000 : undefined);
			const p = r.pricing ?? {};
			return [
				{
					id: r.id,
					displayName: typeof r.name === "string" ? r.name : undefined,
					description: typeof r.description === "string" ? r.description : undefined,
					contextWindow: num(r.context_length) ?? num(r.top_provider?.context_length),
					maxOutputTokens: num(r.top_provider?.max_completion_tokens),
					inputModalities: Array.isArray(r.architecture?.input_modalities) ? r.architecture.input_modalities : undefined,
					pricing: { input: perMillion(p.prompt), output: perMillion(p.completion), cacheRead: perMillion(p.input_cache_read), cacheWrite: perMillion(p.input_cache_write) },
				},
			];
		}),
	);
}

const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** Junie's matching rule: same id, or same id once a date suffix is removed. */
export function listingIdMatches(listedId: string, knownId: string): boolean {
	return listedId === knownId || listedId.replace(DATE_SUFFIX, "") === knownId.replace(DATE_SUFFIX, "");
}

async function getJson(doFetch: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number) {
	const res = await doFetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	let json: unknown;
	if (res.ok) {
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`invalid JSON from ${url}`);
		}
	}
	return { ok: res.ok, status: res.status, text, json };
}

function requireArray(value: unknown, key: string): any[] {
	if (!Array.isArray(value)) throw new Error(`listing has no '${key}' array`);
	return value;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function dedupe(models: ListedModel[]): ListedModel[] {
	const seen = new Set<string>();
	return models.filter((m) => !seen.has(m.id) && seen.add(m.id));
}
