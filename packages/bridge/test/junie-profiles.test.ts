// Junie's custom model profiles (plan step 3): a profile in $JUNIE_HOME/models becomes a "Custom models" choice,
// JUNIE_MODEL=custom:<id> selects it, and its requests carry the profile's key, headers, extraBody and temperature.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadJunieProfiles, profileDirectories } from "pi-junie-config/profiles";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const proxy = await startFakeProxy({ reply: () => "done" });
afterAll(() => proxy.close());
const junieConfigDir = fileURLToPath(new URL("../../junie-config", import.meta.url));
afterEach(() => {
	delete process.env.JUNIE_HOME;
	delete process.env.MY_PROXY_KEY;
});

describe("Junie custom model profiles in the bridge", () => {
	it("offers, selects and calls a profile the way Junie does", async () => {
		const home = mkdtempSync(join(tmpdir(), "junie-home-"));
		mkdirSync(join(home, "models"));
		writeFileSync(
			join(home, "models", "team-claude.json"),
			JSON.stringify({
				baseUrl: `${proxy.url}/team/v1/messages`,
				id: "claude-team",
				displayName: "Team Claude",
				apiType: "Anthropic",
				apiKey: "${MY_PROXY_KEY}",
				extraHeaders: { "X-Team": "core" },
				extraBody: { metadata: { user_id: "eval" } },
				temperature: 0.2,
				efforts: ["low", "high"],
				defaultEffort: "high",
			}),
		);
		Object.assign(process.env, { JUNIE_HOME: home, MY_PROXY_KEY: "team-secret" });
		const profiles = loadJunieProfiles(profileDirectories(undefined)).profiles;
		const backend = await PiBackend.create({
			stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")),
			bundledPlugins: [junieConfigDir],
			junie: { profiles, model: { model: "custom:team-claude" } },
		});
		const wire = new MemoryWire();
		new AcpAgent(wire.agentTransport, backend);
		let id = 0;
		const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
		await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
		const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
		const option = (configId: string) => result.configOptions.find((o: Obj) => o.id === configId);

		expect(option("model").options).toContainEqual(
			expect.objectContaining({ group: "proxy:custom", name: "Custom models", options: [expect.objectContaining({ value: "pi:custom:team-claude/claude-team", name: "Team Claude" })] }),
		);
		expect(option("model").currentValue).toBe("pi:custom:team-claude/claude-team");
		expect(option("effort").currentValue).toBe("high");

		proxy.requests.length = 0;
		await call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "hi" }] });
		const post = proxy.requests.find((r) => r.method === "POST")!;
		expect(post.path).toMatch(/^\/team\/v1\/messages/);
		expect(post.headers["x-api-key"]).toBe("team-secret");
		expect(post.headers["x-team"]).toBe("core");
		expect(post.body).toMatchObject({ model: "claude-team", metadata: { user_id: "eval" }, temperature: 0.2 });
	});
});
