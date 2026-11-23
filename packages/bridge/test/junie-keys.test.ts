// Junie's keys and model choice (plan step 2): a vendor key binds the vendor's slot without a client, JUNIE_API_KEY
// adds the JetBrains AI group, and JUNIE_MODEL / JUNIE_EFFORT pick a new session's model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend, type PiBackendOptions } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const proxy = await startFakeProxy({ reply: () => "done", listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined) });
afterAll(() => proxy.close());
afterEach(() => {
	delete process.env.JUNIE_API_KEY;
});

async function connect(junie: PiBackendOptions["junie"]) {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), junie });
	const wire = new MemoryWire();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	await backend.modelsSettled(5000);
	const { result } = await call("session/new", { cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")), mcpServers: [] });
	const option = (configId: string) => result.configOptions.find((o: Obj) => o.id === configId);
	return { backend, call, sessionId: result.sessionId as string, option };
}

describe("Junie keys", () => {
	it("a vendor key binds the vendor's slot with the real key; a client's binding then replaces it", async () => {
		const junie = {
			credentials: { vendorKeys: [{ vendor: "anthropic" as const, env: "JUNIE_ANTHROPIC_API_KEY", apiKey: "sk-ant-test" }], unsupported: [] },
			vendorBaseUrls: { anthropic: `${proxy.url}/vendor` },
		};
		proxy.requests.length = 0;
		const { backend, call, sessionId } = await connect(junie);
		// discovery asked the vendor with its own auth header
		expect(proxy.requests.find((r) => r.method === "GET")?.headers["x-api-key"]).toBe("sk-ant-test");
		expect(backend.availableModels().map((g) => [g.slotId, g.models.map((m) => m.modelId)])).toEqual([["anthropic", ["claude-opus-5-5-20261001", "claude-sonnet-5-5"]]]);

		await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
		const post = proxy.requests.findLast((r) => r.method === "POST")!;
		expect(post.path).toMatch(/^\/vendor\/v1\/messages/);
		expect(post.headers["x-api-key"]).toBe("sk-ant-test");

		// AIR binds the same slot: its proxy route replaces the key binding, and the key is no longer sent
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: { "x-air-proxy-key": "p" } });
		await backend.modelsSettled(5000);
		await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
		const viaAir = proxy.requests.findLast((r) => r.method === "POST")!;
		expect(viaAir.path).toMatch(/^\/a\/v1\/messages/);
		expect(viaAir.headers["x-api-key"]).not.toBe("sk-ant-test"); // the placeholder, which main.ts strips (proxy-auth.ts)
		expect(viaAir.headers["x-air-proxy-key"]).toBe("p");
	});

	it("JUNIE_API_KEY adds the JetBrains AI group; JUNIE_MODEL and JUNIE_EFFORT pick a new session's model", async () => {
		process.env.JUNIE_API_KEY = "perm-test";
		const { backend, option } = await connect({
			credentials: { junieApiKey: "perm-test", vendorKeys: [], unsupported: [] },
			model: { model: "claude-opus-5-5", effort: "high" },
		});
		const group = backend.availableModels().find((g) => g.slotId === "jetbrains-ai")!;
		expect(group.name).toBe("JetBrains AI");
		expect(group.models.map((m) => m.modelId)).toEqual(expect.arrayContaining(["claude-opus-5-5", "gpt-6-luna", "grok-4.6"]));
		expect(option("model").currentValue).toBe("pi:jetbrains-ai/claude-opus-5-5");
		expect(option("effort").currentValue).toBe("high");
	});

	it("a JUNIE_MODEL that is not available leaves the usual default", async () => {
		const { option } = await connect({
			credentials: { vendorKeys: [{ vendor: "anthropic" as const, env: "JUNIE_ANTHROPIC_API_KEY", apiKey: "k" }], unsupported: [] },
			model: { model: "gpt-6-sol" },
			vendorBaseUrls: { anthropic: `${proxy.url}/vendor` },
		});
		expect(option("model").currentValue).toBe("pi:anthropic/claude-sonnet-5-5");
	});
});
