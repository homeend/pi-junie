import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger, redactSecrets } from "../src/core/log.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

const proxy = await startFakeProxy({
	reply: (req) => `answer #${req.body.messages.filter((m: { role: string }) => m.role === "user").length}`,
	listing: (path) => {
		if (path.endsWith(".anthropic/v1/models")) return [200, LISTINGS.anthropicVendor];
		if (path.endsWith(".openai/models/user")) return [200, LISTINGS.openaiAccount];
		if (path.endsWith(".google/v1beta/models")) return [200, LISTINGS.googleVendor];
		if (path.endsWith(".broken/models/user")) return [500, { error: "boom" }];
		return undefined;
	},
});
afterAll(() => proxy.close());

async function newBackend(stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"))) {
	const lines: string[] = [];
	const backend = await PiBackend.create({
		stateDir,
		logger: createLogger((level, scope, m) => lines.push(`${level} ${m}`)),
		discoveryTimeoutMs: 2000,
	});
	return { backend, lines };
}
async function bind(b: PiBackend, slotId: string, apiType: string, extra: { selectedModels?: string[]; route?: string } = {}) {
	b.bindProvider({ slotId, apiType, baseUrl: `${proxy.url}/jcp.x.${extra.route ?? apiType}/`, headers: { "x-air-proxy-key": "k" }, selectedModels: extra.selectedModels });
	await b.modelsSettled(5000);
}
const ids = (b: PiBackend, slot: string) => b.availableModels().find((g) => g.slotId === slot)?.models.map((m) => m.modelId);

describe("PiBackend model discovery", () => {
	it("offers only what the proxy lists, matched to Pi's catalog", async () => {
		const { backend } = await newBackend();
		await bind(backend, "anthropic", "anthropic");
		await bind(backend, "openai", "openai");
		await bind(backend, "google", "google");
		expect(ids(backend, "anthropic")).toEqual(["claude-opus-5-5-20261001", "claude-sonnet-5-5"]);
		expect(ids(backend, "openai")).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
		expect(ids(backend, "google")).toEqual(["gemini-3.7-flash", "gemini-4-argon"]); // vendor listing: Pi catalog order
	});

	it("uses the account catalog's metadata and AIR's base path conventions", async () => {
		const { backend } = await newBackend();
		await bind(backend, "anthropic", "anthropic");
		await bind(backend, "openai", "openai");
		await bind(backend, "google", "google");
		const sol = backend.resolveModel({ slotId: "openai", modelId: "gpt-6.1-sol" });
		expect(sol?.contextWindow).toBe(400000);
		expect(sol?.cost.input).toBeCloseTo(2);
		expect(sol?.baseUrl).toBe(`${proxy.url}/jcp.x.openai`); // AIR's openai base already is the /v1 base
		expect(backend.resolveModel({ slotId: "anthropic", modelId: "claude-sonnet-5-5" })?.baseUrl).toBe(`${proxy.url}/jcp.x.anthropic`);
		expect(backend.resolveModel({ slotId: "google", modelId: "gemini-4-argon" })?.baseUrl).toBe(`${proxy.url}/jcp.x.google/v1beta`);
	});

	it("narrows an account catalog to AIR's selectedModels, in that order", async () => {
		const { backend } = await newBackend();
		await bind(backend, "openai", "openai", { selectedModels: ["gpt-6-luna", "gpt-not-listed"] });
		expect(ids(backend, "openai")).toEqual(["gpt-6-luna"]);
	});

	it("logs dropped unknown models with a [models-todo] tag", async () => {
		const { backend, lines } = await newBackend();
		await bind(backend, "openai", "openai");
		const todo = lines.filter((l) => l.includes("[models-todo]"));
		expect(todo).toHaveLength(1);
		expect(todo[0]).toContain("openai/gpt-unknown-1");
	});

	it("offers nothing when discovery fails (no fallback)", async () => {
		const { backend, lines } = await newBackend();
		await bind(backend, "openai", "openai", { route: "broken" });
		expect(ids(backend, "openai")).toEqual([]);
		expect(lines.some((l) => l.startsWith("error discovery openai: FAILED"))).toBe(true);
	});

	it("falls back to an available model when the selected model's provider is switched off", async () => {
		const { backend } = await newBackend();
		await bind(backend, "anthropic", "anthropic");
		await bind(backend, "google", "google");
		const s = await backend.openSession({ cwd: "/tmp" });
		await s.selectModel({ slotId: "anthropic", modelId: "claude-sonnet-5-5" });
		backend.unbindProvider("anthropic");
		expect(s.currentModel()).toEqual({ slotId: "google", modelId: "gemini-3.7-flash" });
	});

	it("reports a clear error when every provider is switched off", async () => {
		const { backend } = await newBackend();
		await bind(backend, "anthropic", "anthropic");
		const s = await backend.openSession({ cwd: "/tmp" });
		backend.unbindProvider("anthropic");
		const r = await s.prompt("hi", () => {}, new AbortController().signal);
		expect(r).toMatchObject({ stop: "error" });
		expect(r.error).toContain("No model available");
	});
});

describe("PiBackend session persistence", () => {
	it("resumes a session after an agent restart with its history and model", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
		const first = (await newBackend(stateDir)).backend;
		await bind(first, "anthropic", "anthropic");
		const s1 = await first.openSession({ cwd: "/tmp" });
		await s1.selectModel({ slotId: "anthropic", modelId: "claude-opus-5-5-20261001" });
		const r1 = await s1.prompt("remember 42", () => {}, new AbortController().signal);
		expect(r1.stop).toBe("end_turn");

		// "restart": a fresh backend on the same state dir, as after AIR re-launches the agent
		const second = (await newBackend(stateDir)).backend;
		await bind(second, "anthropic", "anthropic");
		const s2 = await second.resumeSession({ sessionId: s1.id, cwd: "/tmp" });
		expect(s2?.currentModel()).toEqual({ slotId: "anthropic", modelId: "claude-opus-5-5-20261001" });
		let text = "";
		await s2!.prompt("what did I say?", (e) => e.kind === "text" && (text += e.delta), new AbortController().signal);
		expect(text).toBe("answer #2");
		const last = proxy.requests.filter((r) => r.method === "POST").at(-1)!;
		const turns = last.body.messages.filter((m: { role: string }) => m.role !== "system").map((m: { role: string; content: any }) => `${m.role}:${m.content?.[0]?.text}`);
		expect(turns).toEqual(["user:remember 42", "assistant:answer #1", "user:what did I say?"]);
	});

	it("returns undefined for an unknown session id", async () => {
		const { backend } = await newBackend();
		expect(await backend.resumeSession({ sessionId: "pi-nope-1", cwd: "/tmp" })).toBeUndefined();
		expect(await backend.resumeSession({ sessionId: "../etc/passwd", cwd: "/tmp" })).toBeUndefined();
	});
});

describe("log redaction", () => {
	it("masks header values and token env entries", () => {
		const line = JSON.stringify({ headers: { "x-air-proxy-key": "abc", "X-IntelliJ-Proxy-Agent-ID": "id1" }, env: [{ name: "IJ_MCP_AUTH_TOKEN", value: "t0k" }] });
		const out = redactSecrets(line);
		expect(out).not.toContain("abc");
		expect(out).not.toContain("t0k");
		expect(out).toContain("id1");
	});
});
