import { describe, expect, it } from "vitest";
import { junieCredentials, junieModelChoice } from "../src/credentials.ts";

describe("Junie credentials and model choice", () => {
	it("reads the Junie key and the vendor keys; blank counts as unset; other vendors are reported", () => {
		expect(
			junieCredentials({ JUNIE_API_KEY: " perm-a ", JUNIE_ANTHROPIC_API_KEY: "sk-ant", JUNIE_OPENAI_API_KEY: "  ", JUNIE_GROK_API_KEY: "xai", JUNIE_GOOGLE_API_KEY: "g" }),
		).toEqual({
			junieApiKey: "perm-a",
			vendorKeys: [
				{ vendor: "anthropic", env: "JUNIE_ANTHROPIC_API_KEY", apiKey: "sk-ant" },
				{ vendor: "google", env: "JUNIE_GOOGLE_API_KEY", apiKey: "g" },
			],
			unsupported: ["JUNIE_GROK_API_KEY"],
		});
		expect(junieCredentials({})).toEqual({ vendorKeys: [], unsupported: [] });
	});

	it("takes JUNIE_MODEL / JUNIE_EFFORT before the PRIMARY_MODEL properties", () => {
		expect(junieModelChoice({ PRIMARY_MODEL: "gpt-6-sol", PRIMARY_MODEL_REASONING_EFFORT: "High" })).toEqual({ model: "gpt-6-sol", effort: "high" });
		expect(junieModelChoice({ JUNIE_MODEL: "claude-opus-5-5", PRIMARY_MODEL: "gpt-6-sol", JUNIE_EFFORT: "low" })).toEqual({ model: "claude-opus-5-5", effort: "low" });
		expect(junieModelChoice({})).toEqual({});
	});
});
