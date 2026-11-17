import { describe, expect, it } from "vitest";
import { FakeBackend, MemoryWire } from "./harness.ts";
import { AcpAgent } from "../src/acp/agent.ts";

type Obj = Record<string, any>;

async function connected() {
	const wire = new MemoryWire();
	const backend = new FakeBackend();
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = async (method: string, params: Obj = {}) => (await wire.send({ jsonrpc: "2.0", id: ++id, method, params })) as Obj;
	await call("initialize", { protocolVersion: 1, clientInfo: { name: "air-plugin:idea" } });
	return { wire, backend, call };
}

describe("ACP driver", () => {
	it("returns no model option until a provider is bound, then pushes config_option_update", async () => {
		const { wire, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp", mcpServers: [] });
		expect(s.result.configOptions).toEqual([]);
		await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://proxy/openai", headers: {} });
		const [update] = wire.updates("config_option_update") as Obj[];
		expect(update.sessionId).toBe(s.result.sessionId);
		expect(update.update.configOptions[0].currentValue).toBe("pi:openai/gpt-6.1-sol");
	});

	it("switches models with session/set_config_option", async () => {
		const { backend, call } = await connected();
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: "http://proxy/a" });
		const s = await call("session/new", { cwd: "/tmp" });
		const res = await call("session/set_config_option", { sessionId: s.result.sessionId, configId: "model", value: "pi:anthropic/claude-sonnet-5-5" });
		expect(res.result.configOptions[0].currentValue).toBe("pi:anthropic/claude-sonnet-5-5");
		expect(backend.calls).toContain("select anthropic/claude-sonnet-5-5");
	});

	it("exposes an effort option for reasoning models and applies changes", async () => {
		const { backend, call } = await connected();
		await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: "http://proxy/a" });
		const s = await call("session/new", { cwd: "/tmp" });
		const sid = s.result.sessionId;
		await call("session/set_config_option", { sessionId: sid, configId: "model", value: "pi:anthropic/claude-opus-5-5" });
		const res = await call("session/set_config_option", { sessionId: sid, configId: "effort", value: "high" });
		const effort = res.result.configOptions.find((o: Obj) => o.id === "effort");
		expect(effort).toMatchObject({ category: "thought_level", currentValue: "high", _meta: { jetbrains: { air: { recommendedValue: "medium" } } } });
		expect(effort.options.map((o: Obj) => o.value)).toEqual(["low", "medium", "high"]);
		expect(backend.calls).toContain("effort high");
		expect((await call("session/set_config_option", { sessionId: sid, configId: "effort", value: "max" })).error.code).toBe(-32602);
	});

	it("rejects an apiType the slot does not support", async () => {
		const { call } = await connected();
		const res = await call("providers/set", { providerId: "anthropic", apiType: "openai", baseUrl: "http://x" });
		expect(res.error.code).toBe(-32602);
	});

	it("passes AIR's selectedModels to the backend and validates them", async () => {
		const { call } = await connected();
		const ok = await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://x", _meta: { jetbrains: { air: { selectedModels: ["gpt-6.1-sol"] } } } });
		expect(ok.result).toEqual({});
		const bad = await call("providers/set", { providerId: "openai", apiType: "openai", baseUrl: "http://x", _meta: { jetbrains: { air: { selectedModels: "gpt" } } } });
		expect(bad.error.code).toBe(-32602);
	});

	it("session/cancel stops the running turn", async () => {
		const { wire, call } = await connected();
		const s = await call("session/new", { cwd: "/tmp" });
		const pending = call("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type: "text", text: "hi" }] });
		await wire.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.result.sessionId } });
		expect((await pending).result.stopReason).toBe("cancelled");
	});

	it("session/resume reopens a saved session and fails for an unknown one", async () => {
		const { backend, call } = await connected();
		const res = await call("session/resume", { sessionId: "fake-session-7", cwd: "/tmp", mcpServers: [] });
		expect(res.result.configOptions).toEqual([]);
		expect(backend.calls).toContain("resume fake-session-7");
		const prompt = await call("session/prompt", { sessionId: "fake-session-7", prompt: [{ type: "text", text: "again" }] });
		expect(prompt.result.stopReason).toBe("end_turn");
		expect((await call("session/resume", { sessionId: "../x", cwd: "/tmp" })).error.code).toBe(-32002);
	});

	it("session/resume of an unknown chat continues it empty and tells the user", async () => {
		const { wire, call } = await connected();
		const res = await call("session/resume", { sessionId: "pi-old-1", cwd: "/tmp" });
		expect(res.result.configOptions).toEqual([]);
		await new Promise((r) => setTimeout(r, 5));
		const notice = wire.updates("agent_message_chunk").find((u: Obj) => u.sessionId === "pi-old-1") as Obj;
		expect(notice.update.content.text).toContain("could not restore");
		expect((await call("session/prompt", { sessionId: "pi-old-1", prompt: [{ type: "text", text: "hi" }] })).result.stopReason).toBe("end_turn");
	});

	it("advertises session resume", async () => {
		const wire = new MemoryWire();
		new AcpAgent(wire.agentTransport, new FakeBackend());
		const init = (await wire.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })) as Obj;
		expect(init.result.agentCapabilities.sessionCapabilities.resume).toEqual({});
	});

	it("accepts image prompts (advertised) and passes them to the backend", async () => {
		const { backend, call } = await connected();
		const init = (await call("initialize", { protocolVersion: 1 })).result;
		expect(init.agentCapabilities.promptCapabilities.image).toBe(true);
		const s = await call("session/new", { cwd: "/tmp" });
		const res = await call("session/prompt", {
			sessionId: s.result.sessionId,
			prompt: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
		expect(res.result.stopReason).toBe("end_turn");
		expect(backend.calls).toContain(`prompt ${s.result.sessionId}: what is this? +1 image(s)`);
	});

	it("unknown methods get -32601", async () => {
		const { call } = await connected();
		expect((await call("_session/goal")).error.code).toBe(-32601);
	});
});
