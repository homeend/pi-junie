// Replays a recorded AIR session against the real Pi bridge; AIR's proxy is replaced by a local fake.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { loadFixture, replay } from "./harness.ts";

type Obj = Record<string, any>;

describe("Pi bridge replay: junie-hello", async () => {
	const lastUserText = (req: { body: { messages: { role: string; content: any }[] } }) =>
		req.body.messages.filter((m) => m.role === "user").at(-1)?.content?.[0]?.text;
	const proxy = await startFakeProxy({
		reply: (req) => `Hi from ${req.body.model}! You said: ${lastUserText(req)}`,
		listing: (path) => {
			if (path === "/jcp/anthropic/v1/models") return [200, LISTINGS.anthropicVendor]; // /models/user -> 404 -> vendor listing
			if (path === "/jcp/openai/models/user") return [200, LISTINGS.openaiAccount];
			if (path === "/jcp/google/v1beta1/publishers/google/models") return [200, LISTINGS.vertexVendor]; // fixture binds google as vertex
			return undefined;
		},
	});
	afterAll(() => proxy.close());
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
	const fixture = loadFixture("junie-hello");
	const { wire, responses, requests } = await replay(fixture, backend, {
		timeoutMs: 15000,
		transform: (m) =>
			m.method === "providers/set" ? { ...m, params: { ...(m.params as Obj), baseUrl: `${proxy.url}/jcp/${(m.params as Obj).providerId}` } } : m,
	});
	const byMethod = (name: string) => [...requests.values()].filter((r) => r.method === name).map((r) => responses.get(r.id) as Obj);

	it("offers exactly the models the proxy lists for each binding (known to Pi)", () => {
		const [created] = byMethod("session/new");
		const model = created.result.configOptions.find((o: Obj) => o.id === "model");
		const groups = Object.fromEntries(model.options.map((g: Obj) => [g.group, g.options.map((o: Obj) => o.value)]));
		// anthropic: account catalog 404 -> vendor listing, Junie picker order, dated id kept as wire id, unknown dropped
		expect(groups["proxy:anthropic"]).toEqual(["pi:anthropic/claude-opus-5-5-20261001", "pi:anthropic/claude-sonnet-5-5"]);
		// openai: account catalog order, image-only and unknown models dropped
		expect(groups["proxy:openai"]).toEqual(["pi:openai/gpt-6.1-sol", "pi:openai/gpt-6-luna"]);
		expect(groups["proxy:google"]).toEqual(["pi:google/gemini-3.8-flash"]);
		expect(model.currentValue).toBe("pi:anthropic/claude-sonnet-5-5");
	});

	it("asks the proxy with AIR's headers", () => {
		const userCatalog = proxy.requests.find((r) => r.path === "/jcp/openai/models/user");
		expect(userCatalog?.headers["x-air-proxy-key"]).toBe("<redacted>");
		expect(proxy.requests.find((r) => r.path.startsWith("/jcp/anthropic/v1/models"))?.headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("routes prompts through the bound proxy with AIR's headers and streams the answer", () => {
		const prompts = byMethod("session/prompt");
		expect(prompts.map((p) => p.result?.stopReason)).toEqual(["end_turn", "end_turn"]);
		const posts = proxy.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		const first = posts[0];
		expect(first.path).toMatch(/^\/jcp\/anthropic\/v1\/messages(\?|$)/);
		expect(first.body.model).toBe("claude-sonnet-5-5");
		expect(first.headers["x-air-proxy-key"]).toBe("<redacted>"); // header value from the (redacted) fixture
		const text = wire.updates("agent_message_chunk").map((u: Obj) => u.update.content.text).join("");
		expect(text).toContain("Hi from claude-sonnet-5-5! You said:");
		expect(text).toContain("hello");
	});

	it("keeps conversation history across prompts in one session", () => {
		const turns = proxy.requests.filter((r) => r.method === "POST")[1].body.messages.filter((m: { role: string }) => m.role === "user" || m.role === "assistant").map((m: { role: string }) => m.role);
		expect(turns).toEqual(["user", "assistant", "user"]);
	});

	it("reports usage", () => {
		const [p] = byMethod("session/prompt");
		expect(p.result.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
	});
});
