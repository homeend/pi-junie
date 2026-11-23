// Junie's model mixes (its Default model group): levels such as Lite / Normal / Hard / Frontier, each a model and an
// effort, from the account's `JUNIE_MIXES` feature flag (read through the Ingrazzio route, see ingrazzio.ts). Shape as
// Junie parses it (junie-agent JunieMixesCatalogCandidate.kt), schema version 1:
//   {schemaVersion: 1, recommended: "normal", presets: [{id, label, description, selection: {modelId, effort, ecoMode}}]}
// `modelId` is Junie's model setting id (e.g. "claude-opus-5-5", "junie-lite"); `ecoMode` runs the level in Eco mode
// (Junie's Model Mix, junie-cost's planner and router in this repository).

import type { Logger } from "../core/log.ts";

export interface MixPreset {
	id: string;
	label: string;
	description: string;
	modelId: string;
	/** Junie's effort id ("none" = no reasoning effort). */
	effort: string;
	/** The level runs in Eco mode. */
	eco: boolean;
}

export interface MixCatalog {
	presets: MixPreset[];
	recommended?: string;
}

const SCHEMA_VERSION = 1;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The catalog from the flag's value; undefined when absent, of another schema version, or malformed. */
export function parseMixCatalog(value: unknown, log?: Logger): MixCatalog | undefined {
	if (value === undefined || value === null) return undefined;
	const root = value as { schemaVersion?: unknown; recommended?: unknown; presets?: unknown };
	if (typeof value !== "object" || root.schemaVersion !== SCHEMA_VERSION || !Array.isArray(root.presets)) {
		log?.warn(`mixes: catalog not usable (schemaVersion ${JSON.stringify(root?.schemaVersion)}); no Default group`);
		return undefined;
	}
	const presets: MixPreset[] = [];
	for (const raw of root.presets as unknown[]) {
		const p = raw as { id?: unknown; label?: unknown; description?: unknown; selection?: { modelId?: unknown; effort?: unknown; ecoMode?: unknown } };
		const id = str(p?.id);
		const label = str(p?.label);
		const modelId = str(p?.selection?.modelId);
		const effort = str(p?.selection?.effort);
		if (!id || !label || !modelId || !effort) {
			log?.warn(`mixes: skipped a malformed preset ${JSON.stringify(raw)}`);
			continue;
		}
		presets.push({ id, label, description: str(p.description) ?? "", modelId, effort, eco: p.selection?.ecoMode === true });
	}
	const recommended = str(root.recommended);
	return { presets, ...(recommended && presets.some((p) => p.id === recommended) ? { recommended } : {}) };
}
