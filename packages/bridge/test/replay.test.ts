import { describe, expect, it } from "vitest";
import { FakeBackend, loadFixture, replay } from "./harness.ts";

type Obj = Record<string, any>;

describe("replay: junie-hello (handshake, providers, one session, two prompts)", async () => {
	const fixture = loadFixture("junie-hello");
	const backend = new FakeBackend();
	const { wire, responses, requests } = await replay(fixture, backend);
	const byMethod = (m: string) => [...requests.values()].filter((r) => r.method === m).map((r) => responses.get(r.id) as Obj);

	it("answers every request with the same id", () => {
		const requestIds = fixture.client.filter((m) => m.id !== undefined).map((m) => m.id);
		expect([...responses.keys()]).toEqual(requestIds);
	});

	it("initialize advertises ACP v1, provider configuration and the AIR envelope", () => {
		const [init] = byMethod("initialize");
		expect(init.result.protocolVersion).toBe(1);
		expect(init.result.agentCapabilities.providers).toEqual({});
		expect(init.result._meta.jetbrains.air).toEqual({ version: 1, capabilities: [] });
		expect(init.result.agentInfo.name).toBe("pi-junie");
	});

	it("providers/list returns the fixed slots", () => {
		const [list] = byMethod("providers/list");
		expect(list.result.providers.map((p: Obj) => p.providerId)).toEqual(["anthropic", "openai", "google"]);
	});

	it("providers/set binds known slots and rejects unknown ones", () => {
		const sets = [...requests.values()].filter((r) => r.method === "providers/set") as Obj[];
		for (const req of sets) {
			const res = responses.get(req.id) as Obj;
			if (["anthropic", "openai", "google"].includes(req.params.providerId)) expect(res.result).toEqual({});
			else expect(res.error.code).toBe(-32602);
		}
		expect(backend.calls).toContain("bind anthropic anthropic");
		expect(backend.calls).toContain("bind google vertex");
	});

	it("session/new exposes the bound providers' models as a grouped model option", () => {
		const [created] = byMethod("session/new");
		const model = created.result.configOptions.find((o: Obj) => o.id === "model");
		expect(model.category).toBe("model");
		expect(model.options.map((g: Obj) => g.group)).toEqual(["proxy:anthropic", "proxy:openai", "proxy:google"]);
		expect(model.options[0].options[0]).toMatchObject({ value: "pi:anthropic/claude-opus-5-5", name: "claude-opus-5-5" });
		expect(model.currentValue).toBe("pi:anthropic/claude-opus-5-5");
	});

	it("session/prompt streams agent_message_chunk and ends with end_turn", () => {
		const prompts = byMethod("session/prompt");
		expect(prompts).toHaveLength(2);
		for (const p of prompts) expect(p.result.stopReason).toBe("end_turn");
		const text = wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("");
		expect(text).toContain("echo: hello");
		expect(wire.updates("usage_update").length).toBeGreaterThan(0);
	});

	it("session/list answers with an empty list", () => {
		for (const l of byMethod("session/list")) expect(l.result).toEqual({ sessions: [] });
	});
});

describe("replay: junie-multi-session (several sessions, close)", async () => {
	const fixture = loadFixture("junie-multi-session");
	const backend = new FakeBackend();
	const { responses, requests } = await replay(fixture, backend);

	it("answers every request, errors only for slots Pi does not offer", () => {
		for (const [id, res] of responses) {
			const req = requests.get(id) as Obj;
			if ((res as Obj).error) {
				expect(req.method).toBe("providers/set");
				expect(["anthropic", "openai", "google"]).not.toContain(req.params.providerId);
			}
		}
	});

	it("opens, prompts and closes sessions through the backend", () => {
		expect(backend.calls.filter((c) => c.startsWith("open"))).toHaveLength(3);
		expect(backend.calls.filter((c) => c.startsWith("prompt"))).toHaveLength(5);
		expect(backend.calls.filter((c) => c.startsWith("close"))).toHaveLength(1);
	});
});
