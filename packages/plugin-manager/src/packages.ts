/**
 * The installed Pi packages (settings.json `packages`, user and project scope) and their on/off state, as pure
 * functions over the settings entries.
 *
 * Off is the filter `pi config` uses to load none of a package's extensions: the entry in object form with
 * `extensions: []` (Pi docs, packages.md: "Use `[]` to load none of that type"). On removes that filter again; an
 * entry left without filters goes back to its plain source string, as `pi config` does. Other filters (skills,
 * prompts, themes, per-file `+`/`-` patterns) are kept.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export type PackageEntry = string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[]; [key: string]: unknown };
export type Scope = "user" | "project";

export interface InstalledPackage {
	scope: Scope;
	source: string;
	/** Short name: package.json `name` for a local package, the npm name, else the last path segment. */
	name: string;
	enabled: boolean;
}

export const sourceOf = (entry: PackageEntry) => (typeof entry === "string" ? entry : entry.source);

/** Whether the entry loads its extensions: off only with the empty `extensions` filter. */
export const isEnabled = (entry: PackageEntry) => typeof entry === "string" || !(Array.isArray(entry.extensions) && entry.extensions.length === 0);

/** A display name: `npm:@scope/name@1.2` -> `@scope/name`; a local path -> its package.json name. */
export function packageName(source: string, baseDir: string): string {
	if (source.startsWith("npm:")) return source.slice(4).replace(/(.)@[^/]*$/, "$1");
	if (/^(git|https?|ssh):|^git@/.test(source)) return basename(source.replace(/\.git$/, ""));
	const dir = isAbsolute(source) ? source : resolve(baseDir, source);
	try {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
			if (typeof name === "string") return name;
		}
	} catch {
		// fall back to the folder name
	}
	return basename(dir);
}

/** The entry switched on or off; undefined when it already is. */
export function withEnabled(entry: PackageEntry, enabled: boolean): PackageEntry | undefined {
	if (isEnabled(entry) === enabled) return undefined;
	if (!enabled) return typeof entry === "string" ? { source: entry, extensions: [] } : { ...entry, extensions: [] };
	const { extensions: _off, ...rest } = entry as Exclude<PackageEntry, string>;
	return Object.keys(rest).length === 1 ? rest.source : rest;
}

/**
 * The installed package that `query` names: its short name, its source, or a unique part of either (case-insensitive).
 * Returns the matches, so the caller can report none or several.
 */
export function findPackages(packages: readonly InstalledPackage[], query: string): InstalledPackage[] {
	const q = query.trim().toLowerCase();
	const exact = packages.filter((p) => p.name.toLowerCase() === q || p.source.toLowerCase() === q);
	if (exact.length) return exact;
	return packages.filter((p) => p.name.toLowerCase().includes(q) || p.source.toLowerCase().includes(q));
}
