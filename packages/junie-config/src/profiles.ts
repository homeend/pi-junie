/**
 * Junie's custom model profiles (plan step 3): `<dir>/<profileId>.json` files describing a self-hosted or third-party
 * model, loaded with Junie's rules and turned into a Pi provider.
 *
 * Junie sources (junie-agent f38ae6e44c): `core/.../llm/CustomModel.kt` (schema), `CustomModelProfileLoader.kt`
 * (loading, `${VAR}` resolution, merging, validation), `documentation/topics/Custom-LLM-models.md` (user docs).
 * - Locations: the project's `.junie/models`, then `$JUNIE_HOME/models` (default `~/.junie/models`); a profile id
 *   already loaded from an earlier directory is skipped, so the project wins.
 * - `primaryModel` / `fasterModel` override the top level; headers and `extraBody` are merged, the rest replaced.
 * - `${NAME}` in `apiKey` and `extraHeaders` values is read from the environment; a missing variable fails the profile.
 * - Errors are per profile: a bad file is reported and the others still load.
 * - Junie selects a profile as the model `custom:<profileId>`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const API_TYPES = ["OpenAICompletion", "OpenAIResponses", "Google", "Anthropic"] as const;
export type ApiType = (typeof API_TYPES)[number];

export interface ProfileModel {
	id: string;
	baseUrl: string;
	apiType: ApiType;
	apiKey?: string;
	headers: Record<string, string>;
	extraBody?: Record<string, unknown>;
	temperature?: number;
	maxContextLength?: number;
	/** Canonical effort names (standard names in lower case, custom names as declared, trimmed). */
	efforts?: string[];
	defaultEffort?: string;
}

export interface JunieProfile {
	profileId: string;
	displayName: string;
	providerName?: string;
	path: string;
	primary: ProfileModel;
	faster: ProfileModel;
}

export interface ProfileDiscovery {
	profiles: JunieProfile[];
	/** Profile id -> why it was not loaded. */
	errors: Record<string, string>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Junie's default locations: the project's `.junie/models`, then `$JUNIE_HOME/models` (default `~/.junie`). */
export function profileDirectories(projectDir: string | undefined, env: Env = process.env): string[] {
	const home = env.JUNIE_HOME?.trim() || join(homedir(), ".junie");
	return [...(projectDir ? [join(projectDir, ".junie", "models")] : []), join(home, "models")];
}

export function loadJunieProfiles(dirs: readonly string[], env: Env = process.env): ProfileDiscovery {
	const profiles: JunieProfile[] = [];
	const errors: Record<string, string> = {};
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const profileId = basename(file, ".json");
			if (profiles.some((p) => p.profileId === profileId) || profileId in errors) continue;
			const path = join(dir, file);
			try {
				profiles.push(parseProfile(profileId, path, JSON.parse(readFileSync(path, "utf8")), env));
			} catch (err) {
				errors[profileId] = (err as Error).message;
			}
		}
	}
	return { profiles, errors };
}

const STANDARD_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
type Raw = Record<string, unknown>;

function parseProfile(profileId: string, path: string, raw: unknown, env: Env): JunieProfile {
	if (!isObject(raw)) throw new Error("the profile must be a JSON object");
	const top = raw as Raw;
	for (const field of ["baseUrl", "id", "apiType"]) if (typeof top[field] !== "string") throw new Error(`missing required field '${field}'`);
	const topError = effortsError("top level", top.efforts, top.defaultEffort, false);
	if (topError) throw new Error(topError);
	const resolve = (override: unknown, scope: string): ProfileModel => {
		const o = (isObject(override) ? override : {}) as Raw;
		const efforts = (o.efforts ?? top.efforts) as unknown;
		const defaultEffort = (o.defaultEffort ?? top.defaultEffort) as unknown;
		const error = effortsError(scope, efforts, defaultEffort, true);
		if (error) throw new Error(error);
		const apiType = (o.apiType ?? top.apiType) as string;
		if (!(API_TYPES as readonly string[]).includes(apiType)) throw new Error(`unknown apiType '${apiType}' (expected one of ${API_TYPES.join(", ")})`);
		const maxContextLength = (o.maxContextLength ?? top.maxContextLength) as number | undefined;
		if (maxContextLength !== undefined && maxContextLength < 32000) throw new Error(`maxContextLength in ${scope} must be at least 32000, but got ${maxContextLength}`);
		const apiKey = (o.apiKey ?? top.apiKey) as string | undefined;
		const headers = { ...stringMap(top.extraHeaders), ...stringMap(o.extraHeaders) };
		const extraBody = mergeBody(top.extraBody, o.extraBody);
		const temperature = (o.temperature ?? top.temperature) as number | undefined;
		const canonical = canonicalEfforts(efforts as string[] | undefined);
		return {
			id: (o.id ?? top.id) as string,
			baseUrl: (o.baseUrl ?? top.baseUrl) as string,
			apiType: apiType as ApiType,
			...(apiKey !== undefined ? { apiKey: resolveEnv(apiKey, env) } : {}),
			headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolveEnv(v, env)])),
			...(extraBody ? { extraBody } : {}),
			...(temperature !== undefined ? { temperature } : {}),
			...(maxContextLength !== undefined ? { maxContextLength } : {}),
			...(canonical ? { efforts: canonical } : {}),
			...(typeof defaultEffort === "string" ? { defaultEffort: canonicalEffort(defaultEffort, canonical) } : {}),
		};
	};
	return {
		profileId,
		displayName: typeof top.displayName === "string" ? top.displayName : profileId,
		...(typeof top.providerName === "string" ? { providerName: top.providerName } : {}),
		path,
		primary: resolve(top.primaryModel, "primaryModel"),
		faster: resolve(top.fasterModel, "fasterModel"),
	};
}

/** Junie's validateEfforts, with its messages. */
function effortsError(scope: string, efforts: unknown, defaultEffort: unknown, requireEffortsForDefault: boolean): string | undefined {
	if (efforts !== undefined) {
		if (!Array.isArray(efforts) || efforts.length === 0) return `efforts in ${scope} must not be empty`;
		if (efforts.some((e) => typeof e !== "string" || !e.trim())) return `efforts in ${scope} must not contain blank entries`;
	}
	if (defaultEffort !== undefined) {
		if (typeof defaultEffort !== "string" || !defaultEffort.trim()) return `defaultEffort in ${scope} must not be blank`;
		const wanted = defaultEffort.trim();
		if (efforts === undefined) {
			if (requireEffortsForDefault) return `defaultEffort '${wanted}' in ${scope} requires efforts to be specified`;
		} else if (!(efforts as string[]).some((e) => e.trim().toLowerCase() === wanted.toLowerCase())) {
			return `defaultEffort '${wanted}' in ${scope} must be included in efforts (${(efforts as string[]).map((e) => e.trim()).join(", ")})`;
		}
	}
	return undefined;
}

function canonicalEffort(name: string, efforts?: string[]): string {
	const trimmed = name.trim();
	const standard = STANDARD_EFFORTS.find((s) => s === trimmed.toLowerCase());
	const id = standard ?? trimmed;
	return efforts?.find((e) => e.toLowerCase() === id.toLowerCase()) ?? id;
}

function canonicalEfforts(efforts: string[] | undefined): string[] | undefined {
	if (!efforts) return undefined;
	const out: string[] = [];
	for (const e of efforts.map((x) => canonicalEffort(x))) if (!out.some((o) => o.toLowerCase() === e.toLowerCase())) out.push(e);
	return out;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function resolveEnv(value: string, env: Env): string {
	return value.replace(ENV_REFERENCE, (_, name: string) => {
		const v = env[name];
		if (v === undefined) throw new Error(`Environment variable '${name}' referenced in the profile is not set`);
		return v;
	});
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
	return isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string> : {};
}

/** Recursive merge: nested objects merge, anything else in the override replaces (Junie's mergeJsonObjectsRecursively). */
export function mergeBody(base: unknown, override: unknown): Record<string, unknown> | undefined {
	if (!isObject(base)) return isObject(override) ? { ...override } : undefined;
	if (!isObject(override)) return { ...base };
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(override)) out[k] = isObject(out[k]) && isObject(v) ? mergeBody(out[k], v) : v;
	return out;
}
