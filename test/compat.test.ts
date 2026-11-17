import { describe, expect, it } from "vitest";
import { compareVersions, resolveFeatures, type FeatureRule } from "../src/compat/features.ts";

const rules: FeatureRule[] = [
	{ feature: "nativeSubagentSessions", description: "", requires: [{ plugin: "pi-subagents", minVersion: "1.2.0" }], status: "available" },
	{ feature: "customInstructions", description: "", requires: [], status: "available" },
	{ feature: "planFile", description: "", requires: [], status: "planned" },
];

describe("compat feature resolution", () => {
	it("advertises features whose plugins are installed", () => {
		const r = resolveFeatures([{ name: "pi-subagents", version: "1.3.0" }], [], rules);
		expect(r.advertised).toEqual(["nativeSubagentSessions", "customInstructions"]);
	});
	it("explains why a client-wanted feature is unavailable", () => {
		const r = resolveFeatures([{ name: "pi-subagents", version: "1.0.0" }], ["nativeSubagentSessions", "planFile"], rules);
		expect(r.advertised).toEqual(["customInstructions"]);
		expect(r.unavailable).toEqual([
			{ feature: "nativeSubagentSessions", reason: "requires pi-subagents >= 1.2.0, found 1.0.0" },
			{ feature: "planFile", reason: "not implemented in pi-junie yet" },
		]);
	});
	it("compares versions numerically", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
		expect(compareVersions("2.0", "2.0.0")).toBe(0);
	});
});
