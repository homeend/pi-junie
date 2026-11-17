// Replays a recorded AIR session against the real Pi bridge; AIR's proxy is replaced by a local fake.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { startFakeAnthropic } from "./fake-anthropic.ts";
import { loadFixture, replay } from "./harness.ts";

type Obj = Record<string, any>;

describe("Pi bridge replay: junie-hello", async () => {
	const lastUserText = (req: { body: { messages: { role: string; content: any }[] } }) =>
		req.body.messages.filter((m) => m.role === "user").at(-1)?.content?.[0]?.text;
	const proxy = await startFakeAnthropic((req) => `Hi from ${req.body.model}! You said: ${lastUserText(req)}`);
	afterAll(() => proxy.close());
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
	const fixture = loadFixture("junie-hello");
	const { wire, responses, requests } = await replay(fixture, backend, {
		timeoutMs: 15000,
		transform: (m) =>
			m.method === "providers/set" ? { ...m, params: { ...(m.params as Obj), baseUrl: `${proxy.url}/jcp/${(m.params as Obj).providerId}` } } : m,
	});
	const byMethod = (name: string) => [...requests.values()].filter((r) => r.method === name).map((r) => responses.get(r.id) as Obj);

	it("lists Pi's curated models for every bound slot", () => {
		const [created] = byMethod("session/new");
		const model = created.result.configOptions.find((o: Obj) => o.id === "model");
		const groups = Object.fromEntries(model.options.map((g: Obj) => [g.group, g.options.map((o: Obj) => o.value)]));
		expect(groups["proxy:anthropic"]).toContain("pi:anthropic/claude-opus-5-5");
		expect(groups["proxy:openai"]).toContain("pi:openai/gpt-6.1-sol");
		expect(groups["proxy:google"]).toContain("pi:google/gemini-3.7-flash");
		expect(model.currentValue).toBe("pi:anthropic/claude-sonnet-5-5");
		expect(model.options[0].options[0].name).toBe("Claude Fable 5.2");
	});

	it("routes prompts through the bound proxy with AIR's headers and streams the answer", () => {
		const prompts = byMethod("session/prompt");
		expect(prompts.map((p) => p.result?.stopReason)).toEqual(["end_turn", "end_turn"]);
		expect(proxy.requests).toHaveLength(2);
		const first = proxy.requests[0];
		expect(first.path).toMatch(/^\/jcp\/anthropic\/v1\/messages(\?|$)/);
		expect(first.body.model).toBe("claude-sonnet-5-5");
		expect(first.headers["x-air-proxy-key"]).toBe("<redacted>"); // header value from the (redacted) fixture
		const text = wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("");
		expect(text).toContain("Hi from claude-sonnet-5-5! You said:");
		expect(text).toContain("hello");
	});

	it("keeps conversation history across prompts in one session", () => {
		const turns = proxy.requests[1].body.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => m.role);
		expect(turns).toEqual(["user", "assistant", "user"]);
	});

	it("reports usage", () => {
		const [p] = byMethod("session/prompt");
		expect(p.result.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
	});
});
