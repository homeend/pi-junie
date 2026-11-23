import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effortLevels, endpointBase, profileProvider } from "../src/profile-provider.ts";
import { loadJunieProfiles, profileDirectories } from "../src/profiles.ts";
import { withProfileOptions } from "../src/request-options.ts";

function dirWith(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "junie-models-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body));
	return dir;
}

// Junie's documentation examples (documentation/topics/Custom-LLM-LiteLLM.md, Custom-LLM-models.md)
const LITELLM = { baseUrl: "http://localhost:4000/v1/chat/completions", id: "my-coder-model", apiType: "OpenAICompletion", apiKey: "sk-1234" };
const OPENROUTER = {
	baseUrl: "https://openrouter.ai/api/v1/chat/completions",
	id: "your-model",
	apiType: "OpenAICompletion",
	apiKey: "${OPENROUTER_API_KEY}",
	extraHeaders: { "X-Custom-Auth": "${CUSTOM_AUTH_TOKEN}" },
};

describe("Junie custom model profiles", () => {
	it("loads Junie's documented examples; the file name is the profile id; ${VAR} comes from the environment", () => {
		const { profiles, errors } = loadJunieProfiles([dirWith({ litellm: LITELLM, openrouter: OPENROUTER })], { OPENROUTER_API_KEY: "or-key", CUSTOM_AUTH_TOKEN: "tok" });
		expect(errors).toEqual({});
		expect(profiles.map((p) => [p.profileId, p.displayName, p.primary.id, p.primary.apiKey, p.primary.headers])).toEqual([
			["litellm", "litellm", "my-coder-model", "sk-1234", {}],
			["openrouter", "openrouter", "your-model", "or-key", { "X-Custom-Auth": "tok" }],
		]);
		expect(profiles[0].faster).toEqual(profiles[0].primary);
	});

	it("reports a bad profile with Junie's message and still loads the others", () => {
		const { profiles, errors } = loadJunieProfiles(
			[
				dirWith({
					good: LITELLM,
					missingVar: OPENROUTER,
					small: { ...LITELLM, maxContextLength: 8000 },
					badDefault: { ...LITELLM, efforts: ["low", "high"], defaultEffort: "medium" },
					roleDefault: { ...LITELLM, primaryModel: { id: "x", defaultEffort: "high" } },
					noApi: { baseUrl: "http://x", id: "m" },
					broken: "{ not json",
				}),
			],
			{},
		);
		expect(profiles.map((p) => p.profileId)).toEqual(["good"]);
		expect(errors).toMatchObject({
			missingVar: "Environment variable 'OPENROUTER_API_KEY' referenced in the profile is not set",
			small: "maxContextLength in primaryModel must be at least 32000, but got 8000",
			badDefault: "defaultEffort 'medium' in top level must be included in efforts (low, high)",
			roleDefault: "defaultEffort 'high' in primaryModel requires efforts to be specified",
			noApi: "missing required field 'apiType'",
		});
		expect(errors.broken).toBeTruthy();
	});

	it("merges roles like Junie: simple fields replaced, headers added, extraBody merged recursively", () => {
		const { profiles } = loadJunieProfiles(
			[
				dirWith({
					p: {
						...LITELLM,
						extraHeaders: { A: "1", B: "2" },
						extraBody: { tags: ["t"], meta: { a: 1, b: 1 } },
						temperature: 0.6,
						fasterModel: { id: "small", extraHeaders: { B: "3" }, extraBody: { meta: { b: 2 } }, temperature: 0 },
					},
				}),
			],
			{},
		);
		const [{ primary, faster }] = profiles;
		expect([primary.id, primary.headers, primary.temperature]).toEqual(["my-coder-model", { A: "1", B: "2" }, 0.6]);
		expect([faster.id, faster.headers, faster.extraBody, faster.temperature]).toEqual(["small", { A: "1", B: "3" }, { tags: ["t"], meta: { a: 1, b: 2 } }, 0]);
	});

	it("the project's profile wins over the user's; JUNIE_HOME moves the user location", () => {
		const home = mkdtempSync(join(tmpdir(), "junie-home-"));
		const project = mkdtempSync(join(tmpdir(), "junie-proj-"));
		mkdirSync(join(home, "models"));
		mkdirSync(join(project, ".junie", "models"), { recursive: true });
		writeFileSync(join(home, "models", "p.json"), JSON.stringify({ ...LITELLM, id: "user" }));
		writeFileSync(join(home, "models", "q.json"), JSON.stringify(LITELLM));
		writeFileSync(join(project, ".junie", "models", "p.json"), JSON.stringify({ ...LITELLM, id: "project" }));
		const dirs = profileDirectories(project, { JUNIE_HOME: home });
		expect(loadJunieProfiles(dirs, {}).profiles.map((p) => [p.profileId, p.primary.id])).toEqual([
			["p", "project"],
			["q", "my-coder-model"],
		]);
	});
});

describe("profile as a Pi provider", () => {
	it("drops the endpoint path Pi's clients append themselves", () => {
		const base = (baseUrl: string, apiType: any) => endpointBase({ id: "m", baseUrl, apiType, headers: {} });
		expect(base("http://localhost:4000/v1/chat/completions", "OpenAICompletion")).toBe("http://localhost:4000/v1");
		expect(base("http://localhost:11434/v1/responses", "OpenAIResponses")).toBe("http://localhost:11434/v1");
		expect(base("https://proxy.example/anthropic/v1/messages", "Anthropic")).toBe("https://proxy.example/anthropic");
		expect(base("https://proxy.example/v1", "OpenAICompletion")).toBe("https://proxy.example/v1");
	});

	it("maps efforts to Pi levels, custom names onto free levels; the declared name is what is sent", () => {
		expect([...effortLevels(["none", "low", "high"])]).toEqual([["none", "off"], ["low", "low"], ["high", "high"]]);
		expect([...effortLevels(["turbo", "deep"])]).toEqual([["turbo", "low"], ["deep", "medium"]]);
		const { profiles } = loadJunieProfiles([dirWith({ p: { ...LITELLM, efforts: ["turbo", "deep"], defaultEffort: "deep", maxContextLength: 64000 } })], {});
		const provider = profileProvider(profiles[0], "placeholder");
		expect(provider.providerId).toBe("junie-custom-p");
		expect(provider.defaultLevel).toBe("medium");
		expect(provider.config).toMatchObject({ baseUrl: "http://localhost:4000/v1", apiKey: "sk-1234", api: "openai-completions" });
		expect(provider.config.models![0]).toMatchObject({
			id: "my-coder-model",
			reasoning: true,
			contextWindow: 64000,
			thinkingLevelMap: { minimal: null, low: "turbo", medium: "deep", high: null, xhigh: null, max: null },
		});
	});

	it("without efforts no reasoning; without apiKey the caller's placeholder", () => {
		const { profiles } = loadJunieProfiles([dirWith({ p: { ...LITELLM, apiKey: undefined } })], {});
		const provider = profileProvider(profiles[0], "placeholder");
		expect(provider.config.apiKey).toBe("placeholder");
		expect(provider.config.models![0]).toMatchObject({ reasoning: false });
		expect(provider.config.models![0]).not.toHaveProperty("thinkingLevelMap");
	});

	it("request options: extraBody merged over the body, temperature where the API takes it", () => {
		const model = { id: "m", baseUrl: "x", apiType: "OpenAICompletion" as const, headers: {}, temperature: 0.3, extraBody: { tags: ["a"], model: "override" } };
		expect(withProfileOptions({ model: "m", messages: [] }, model)).toEqual({ model: "override", messages: [], temperature: 0.3, tags: ["a"] });
		expect(withProfileOptions({ generationConfig: { maxOutputTokens: 5 } }, { ...model, apiType: "Google", extraBody: undefined })).toEqual({ generationConfig: { maxOutputTokens: 5, temperature: 0.3 } });
	});
});
