// Compatibility layer: maps client-side product features (AIR `_meta.jetbrains.air.capabilities`)
// to agent-side plugin requirements, in both directions.
//
// - Advertise: a feature is announced to the client only if every requirement is satisfied.
// - Diagnose: features the client supports but we cannot offer are reported with the missing requirements.

export interface PluginRequirement {
	plugin: string;
	/** Minimal version, compared numerically per dot segment. Omit for "any version". */
	minVersion?: string;
}

export interface FeatureRule {
	feature: string;
	description: string;
	requires: PluginRequirement[];
	/** "planned": known but not implemented in the bridge yet; never advertised. */
	status: "available" | "planned";
}

export interface InstalledPlugin {
	name: string;
	version?: string;
}

export interface FeatureResolution {
	advertised: string[];
	unavailable: { feature: string; reason: string }[];
}

/** Known AIR features with a capability string. Only subagent sessions are "available"; the rest are "planned". */
export const AIR_FEATURE_RULES: FeatureRule[] = [
	{ feature: "nativeSubagentSessions", description: "Child sessions for subagents", requires: [{ plugin: "@tintinweb/pi-subagents", minVersion: "0.26.0" }], status: "available" },
	{ feature: "customInstructions", description: "Session instructions from AIR on session/new", requires: [], status: "planned" },
	{ feature: "providerModels", description: "_providers/models catalog probe", requires: [], status: "planned" },
	{ feature: "sessionIndex", description: "Session list with AIR metadata", requires: [], status: "planned" },
	{ feature: "planFile", description: "Plan files linked to plan updates", requires: [{ plugin: "plan-mode" }], status: "planned" },
	{ feature: "agentFileChangeReport", description: "Changed-file reports after a turn", requires: [], status: "planned" },
];

export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return Math.sign(d);
	}
	return 0;
}

function missingRequirement(req: PluginRequirement, installed: InstalledPlugin[]): string | undefined {
	const plugin = installed.find((p) => p.name === req.plugin);
	if (!plugin) return `requires plugin ${req.plugin}${req.minVersion ? ` >= ${req.minVersion}` : ""}`;
	if (req.minVersion && (!plugin.version || compareVersions(plugin.version, req.minVersion) < 0)) {
		return `requires ${req.plugin} >= ${req.minVersion}, found ${plugin.version ?? "unknown version"}`;
	}
	return undefined;
}

export function resolveFeatures(
	installed: InstalledPlugin[],
	clientFeatures: string[],
	rules: FeatureRule[] = AIR_FEATURE_RULES,
): FeatureResolution {
	const advertised: string[] = [];
	const unavailable: FeatureResolution["unavailable"] = [];
	for (const rule of rules) {
		const wantedByClient = clientFeatures.includes(rule.feature);
		if (rule.status === "planned") {
			if (wantedByClient) unavailable.push({ feature: rule.feature, reason: "not implemented in pi-junie yet" });
			continue;
		}
		const missing = rule.requires.map((r) => missingRequirement(r, installed)).filter((m): m is string => !!m);
		if (missing.length === 0) advertised.push(rule.feature);
		else if (wantedByClient) unavailable.push({ feature: rule.feature, reason: missing.join("; ") });
	}
	return { advertised, unavailable };
}
