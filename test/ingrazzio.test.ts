// The `ingrazzio` provider slot: the client's route to JetBrains' Ingrazzio API, where the bridge reads the account's
// feature flags (as Junie does). It serves no models.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { type FakeRequest, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;

const FLAGS = { JUNIE_MIXES: { presets: [] }, ECO_MODE_IMPLEMENTATION: { modelId: "m", effort: "low" }, OTHER: true };
const seen: FakeRequest[] = [];
const proxy = await startFakeProxy({
	listing: (path, req) => {
		seen.push(req);
		return path.endsWith("/api/feature-flags/ga") ? [200, FLAGS] : undefined;
	},
});
afterAll(() => proxy.close());

async function connect() {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
	const wire = new MemoryWire();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: {} });
	return { call, backend };
}

describe("ingrazzio slot", () => {
	it("is listed as a provider slot of its own api type", async () => {
		const { call } = await connect();
		const { result } = await call("providers/list");
		expect(result.providers.find((p: Obj) => p.providerId === "ingrazzio")).toEqual({ providerId: "ingrazzio", supported: ["ingrazzio"], required: false, current: null });
	});

	it("reads the feature flags through the route with the client's headers and offers no models from it", async () => {
		const { call, backend } = await connect();
		const set = await call("providers/set", { providerId: "ingrazzio", apiType: "ingrazzio", baseUrl: `${proxy.url}/route.ingrazzio`, headers: { "x-air-proxy-key": "k" } });
		expect(set.result).toEqual({});
		await backend.modelsSettled(5000);
		const flags = seen.find((r) => r.path === "/route.ingrazzio/api/feature-flags/ga");
		expect(flags?.headers["x-air-proxy-key"]).toBe("k");
		expect(backend.availableModels()).toEqual([]);
		const { result } = await call("providers/list");
		expect(result.providers.find((p: Obj) => p.providerId === "ingrazzio").current).toMatchObject({ apiType: "ingrazzio" });
	});
});
