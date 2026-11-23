import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { junieBehavior, projectStructure } from "../src/behavior.ts";
import { withRequestSettings } from "../src/request-options.ts";

describe("Junie behavior settings", () => {
	it("step limit: MAX_STEPS, else Junie's 150 outside interactive mode, else none", () => {
		expect(junieBehavior({ MAX_STEPS: "60" }).maxSteps).toBe(60);
		expect(junieBehavior({ JUNIE_EXECUTION_MODE: "NonInteractive" }).maxSteps).toBe(150);
		expect(junieBehavior({ JUNIE_EXECUTION_MODE: "NonInteractive", MAX_STEPS: "x" }).maxSteps).toBe(150);
		expect(junieBehavior({ JUNIE_EXECUTION_MODE: "Interactive" }).maxSteps).toBeUndefined();
		expect(junieBehavior({}).maxSteps).toBeUndefined();
	});

	it("project structure only for exactly `true`; tool switches as Junie parses them", () => {
		expect(junieBehavior({ ADD_PROJECT_STR: "true" }).addProjectStructure).toBe(true);
		expect(junieBehavior({ ADD_PROJECT_STR: "TRUE" }).addProjectStructure).toBe(false);
		expect(junieBehavior({ SUBAGENTS_ENABLED: "false", WEB_SEARCH_MODE: "Off", FETCH_URL_ENABLED: "false" }).disabledTools).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
			"web_search",
			"source_check",
			"fetch_content",
			"get_search_content",
		]);
		expect(junieBehavior({ WEB_SEARCH_MODE: "tool", SUBAGENTS_ENABLED: "true" }).disabledTools).toEqual([]);
	});

	it("request settings from PRIMARY_MODEL_*", () => {
		expect(
			junieBehavior({ PRIMARY_MODEL_TEMPERATURE: "0.5", PRIMARY_MODEL_MAX_TOKENS: "4096", PRIMARY_MODEL_PARALLEL_TOOL_CALLS: "false", PRIMARY_MODEL_PROMPT_CACHE_ENABLED: "false" }).request,
		).toEqual({ temperature: 0.5, maxTokens: 4096, parallelToolCalls: false, promptCache: false });
		expect(junieBehavior({}).request).toEqual({});
	});

	it("Junie's root listing: hidden and build-like directories skipped, sorted", () => {
		const root = mkdtempSync(join(tmpdir(), "proj-"));
		for (const d of ["src", "build", ".git", "venv", "docs"]) mkdirSync(join(root, d));
		for (const f of ["README.md", ".env", "build.gradle.kts"]) writeFileSync(join(root, f), "");
		expect(projectStructure(root)).toBe(
			`## PROJECT STRUCTURE\nProject root directory: ${root}\nBelow are the files and directories in the project's root directory (\`ls\`).\n\n` +
				"README.md\nbuild.gradle.kts\ndocs\nsrc\n\nDon't run the `ls` command for the project's root directory. Instead, use the information provided above.",
		);
		expect(projectStructure(join(root, "missing"))).toBeUndefined();
	});
});

describe("request settings per API", () => {
	const tools = [{ name: "bash" }];
	it("Anthropic: temperature, max_tokens, no parallel tool use, no cache_control", () => {
		const body = { model: "c", max_tokens: 100, tools, system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }] };
		expect(withRequestSettings(body, "anthropic-messages", { temperature: 0.1, maxTokens: 50, parallelToolCalls: false, promptCache: false })).toEqual({
			model: "c",
			max_tokens: 50,
			tools,
			temperature: 0.1,
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
			system: [{ type: "text", text: "s" }],
		});
	});

	it("OpenAI Responses and Completions, Google", () => {
		expect(withRequestSettings({ tools, prompt_cache_key: "k" }, "openai-responses", { maxTokens: 9, parallelToolCalls: false, promptCache: false })).toEqual({
			tools,
			max_output_tokens: 9,
			parallel_tool_calls: false,
		});
		expect(withRequestSettings({ max_completion_tokens: 1 }, "openai-completions", { maxTokens: 9 })).toEqual({ max_completion_tokens: 9 });
		expect(withRequestSettings({}, "openai-completions", { maxTokens: 9 })).toEqual({ max_tokens: 9 });
		expect(withRequestSettings({ generationConfig: { topP: 1 } }, "google-generative-ai", { temperature: 1, maxTokens: 9 })).toEqual({
			generationConfig: { topP: 1, temperature: 1, maxOutputTokens: 9 },
		});
	});
});
