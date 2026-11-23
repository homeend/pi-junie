// Junie Config ships with the bridge: with Junie's settings in the environment, a session records them (credentials
// masked) as Junie records agent_configuration; without them it records nothing.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

const proxy = await startFakeProxy({ reply: () => "done", listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined) });
afterAll(() => proxy.close());
const junieConfigDir = fileURLToPath(new URL("../../junie-config", import.meta.url));
const ENV = { JUNIE_MODEL: "claude-sonnet-5-5", MODEL_MIX_ENABLED: "true", JUNIE_API_KEY: "perm-not-for-files" };
afterEach(() => {
	for (const k of Object.keys(ENV)) delete process.env[k];
});

async function recordedEntries(): Promise<Record<string, any>[]> {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
	const backend = await PiBackend.create({ stateDir, bundledPlugins: [junieConfigDir] });
	backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(3000);
	const session = await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")) });
	await session.prompt({ text: "hi", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");
	const dir = join(stateDir, "sessions", "pi");
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
	const text = readFileSync(join(dir, file), "utf8");
	expect(text).not.toContain("perm-not-for-files");
	return text.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "custom" && e.customType === "junie-config");
}

describe("Junie Config in a bridge session", () => {
	it("records the resolved Junie settings once, credentials masked", async () => {
		Object.assign(process.env, ENV);
		const entries = await recordedEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].data.settings).toMatchObject({ junie_model: "claude-sonnet-5-5", model_mix_enabled: "true", junie_api_key: "<set>", web_search_mode: "tool" });
		expect(entries[0].data.fromEnv).toEqual(["model_mix_enabled", "junie_model", "junie_api_key"]);
	});

	it("records nothing without Junie settings", async () => {
		expect(await recordedEntries()).toEqual([]);
	});
});
