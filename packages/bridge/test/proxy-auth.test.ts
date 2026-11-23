// The placeholder API key never reaches the AIR proxy; the proxy's own headers do (like Junie).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { withoutPlaceholderAuth } from "../src/pi/proxy-auth.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

const proxy = await startFakeProxy({
	reply: () => "ok",
	listing: (path) => {
		if (path.endsWith(".anthropic/v1/models")) return [200, LISTINGS.anthropicVendor];
		if (path.endsWith(".openai/models/user")) return [200, LISTINGS.openaiAccount];
		if (path.endsWith(".vertex/v1beta1/publishers/google/models")) return [200, LISTINGS.vertexVendor];
		if (path.endsWith(".google/v1beta/models")) return [200, LISTINGS.googleVendor];
		return undefined;
	},
});
const original = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = withoutPlaceholderAuth(original);
});
afterAll(async () => {
	globalThis.fetch = original;
	await proxy.close();
});

const AUTH = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

describe("proxy auth", () => {
	it.each([
		["anthropic", "anthropic", "claude-sonnet-5-5"],
		["openai", "openai", "gpt-6.1-sol"],
		["google", "google", "gemini-4-argon"],
		["google", "vertex", "gemini-3.8-flash"],
	])("%s/%s sends the proxy headers and no placeholder key", async (slotId, apiType, modelId) => {
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
		backend.bindProvider({ slotId, apiType, baseUrl: `${proxy.url}/jcp.x.${apiType}`, headers: { "x-air-proxy-key": "proxy-key" } });
		await backend.modelsSettled(5000);
		const session = await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")) });
		await session.selectModel({ slotId, modelId });
		const before = proxy.requests.length;
		await session.prompt({ text: "hi", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");
		const post = proxy.requests.slice(before).find((r) => r.method === "POST")!;
		expect(post, `no model request for ${apiType}`).toBeDefined();
		expect(post.headers["x-air-proxy-key"]).toBe("proxy-key");
		for (const h of AUTH) expect(post.headers[h], `${apiType} ${h}`).toBeUndefined();
		expect(post.path).not.toContain("air-proxy"); // not as a ?key= query either
	});

	it("leaves real keys alone", async () => {
		const seen: Headers[] = [];
		const f = withoutPlaceholderAuth(async (_i, init) => {
			seen.push(new Headers(init?.headers));
			return new Response("");
		});
		await f("http://x", { headers: { authorization: "Bearer sk-real", "x-api-key": "air-proxy" } });
		expect(seen[0].get("authorization")).toBe("Bearer sk-real");
		expect(seen[0].get("x-api-key")).toBeNull();
	});
});
