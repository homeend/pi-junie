import { describe, expect, it } from "vitest";
import { configurationRecord, describeJunieSettings, JUNIE_SETTINGS, resolveJunieSettings } from "../src/settings.ts";

describe("Junie settings", () => {
	it("without environment: only Junie's defaults, nothing to log", () => {
		const resolved = resolveJunieSettings({});
		expect(resolved.every((r) => r.source === "default")).toBe(true);
		expect(configurationRecord(resolved).settings).toEqual({
			primary_model_prompt_cache_enabled: "true",
			primary_use_tools: "true",
			primary_model_include_encrypted_content: "true",
			demo_max_steps: "400",
			web_search_mode: "tool",
			fetch_url_enabled: "true",
			force_mermaid_graphs: "false",
			subagents_mode: "Auto",
			chat_repository_observation: "true",
			junie_stop_hook_block_cap: "8",
		});
		expect(describeJunieSettings(resolved)).toBeUndefined();
	});

	it("an environment variable wins over the default, even when empty, as in Junie", () => {
		const resolved = resolveJunieSettings({ MODEL_MIX_ENABLED: "true", WEB_SEARCH_MODE: "", MAX_STEPS: "60", UNRELATED: "x" });
		const record = configurationRecord(resolved);
		expect(record.settings).toMatchObject({ model_mix_enabled: "true", web_search_mode: "", max_steps: "60" });
		expect(record.fromEnv).toEqual(["model_mix_enabled", "max_steps", "web_search_mode"]);
	});

	it("never records or logs a credential's value", () => {
		const env = { JUNIE_API_KEY: "perm-secret-value", JUNIE_OPENAI_API_KEY: "sk-secret", JUNIE_MODEL: "claude-opus-5-5" };
		const resolved = resolveJunieSettings(env);
		const record = JSON.stringify(configurationRecord(resolved));
		const line = describeJunieSettings(resolved)!;
		for (const text of [record, line]) {
			expect(text).not.toContain("secret");
			expect(text).toContain("<set>");
		}
		expect(line).toBe('JUNIE_MODEL="claude-opus-5-5" JUNIE_API_KEY=<set> JUNIE_OPENAI_API_KEY=<set>');
	});

	it("has one entry per name and per environment variable", () => {
		expect(new Set(JUNIE_SETTINGS.map((s) => s.name)).size).toBe(JUNIE_SETTINGS.length);
		expect(new Set(JUNIE_SETTINGS.map((s) => s.env)).size).toBe(JUNIE_SETTINGS.length);
	});
});
