// Junie's behavior settings (plan step 4) in a bridge session: MAX_STEPS ends a run after that many turns,
// ADD_PROJECT_STR puts Junie's root listing in the system prompt, PRIMARY_MODEL_* shape the requests.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: () => ({ tool: "bash", input: { command: "true" } }), // never finishes on its own
});
afterAll(() => proxy.close());
const junieConfigDir = fileURLToPath(new URL("../../junie-config", import.meta.url));
const ENV = { MAX_STEPS: "3", ADD_PROJECT_STR: "true", PRIMARY_MODEL_TEMPERATURE: "0.4", PRIMARY_MODEL_PARALLEL_TOOL_CALLS: "false" };
afterEach(() => {
	for (const k of Object.keys(ENV)) delete process.env[k];
});

describe("Junie behavior settings in a bridge session", () => {
	it("stops at MAX_STEPS, lists the project root, applies the request settings", async () => {
		Object.assign(process.env, ENV);
		const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
		const project = mkdtempSync(join(tmpdir(), "pi-junie-proj-"));
		writeFileSync(join(project, "pom.xml"), "");
		const backend = await PiBackend.create({ stateDir, bundledPlugins: [junieConfigDir] });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		const session = await backend.openSession({ cwd: project });
		proxy.requests.length = 0;
		await session.prompt({ text: "loop", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");

		const posts = proxy.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(3);
		const system = JSON.stringify(posts[0].body.system);
		expect(system).toContain("## PROJECT STRUCTURE");
		expect(system).toContain(`Project root directory: ${project}`);
		expect(system).toContain("pom.xml");
		expect(posts[0].body).toMatchObject({ temperature: 0.4, tool_choice: { disable_parallel_tool_use: true } });

		const dir = join(stateDir, "sessions", "pi");
		const lines = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.filter((e) => e.customType === "junie-exit").map((e) => e.data)).toEqual([{ status: "ExitMaxIter", steps: 3, maxSteps: 3 }]);
	});
});
