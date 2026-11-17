import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/core/log.ts";
import { PiBackend } from "../src/pi/backend.ts";

const newBackend = () => PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
const bind = (b: PiBackend, slotId: string, apiType: string) =>
	b.bindProvider({ slotId, apiType, baseUrl: `http://127.0.0.1:40975/jcp.x.${apiType}/`, headers: { "x-air-proxy-key": "k" } });

describe("PiBackend provider binding", () => {
	it("appends the API version path Pi's clients expect to AIR's bare proxy root", async () => {
		const b = await newBackend();
		bind(b, "anthropic", "anthropic");
		bind(b, "openai", "openai");
		bind(b, "google", "google");
		expect(b.resolveModel({ slotId: "anthropic", modelId: "claude-opus-5-5" })?.baseUrl).toBe("http://127.0.0.1:40975/jcp.x.anthropic");
		expect(b.resolveModel({ slotId: "openai", modelId: "gpt-6.1-sol" })?.baseUrl).toBe("http://127.0.0.1:40975/jcp.x.openai/v1");
		expect(b.resolveModel({ slotId: "google", modelId: "gemini-3.7-flash" })?.baseUrl).toBe("http://127.0.0.1:40975/jcp.x.google/v1beta");
	});

	it("falls back to an available model when the selected model's provider is switched off", async () => {
		const b = await newBackend();
		bind(b, "anthropic", "anthropic");
		bind(b, "google", "google");
		const s = await b.openSession({ cwd: "/tmp" });
		await s.selectModel({ slotId: "anthropic", modelId: "claude-opus-5-5" });
		b.unbindProvider("anthropic");
		expect(s.currentModel()).toEqual({ slotId: "google", modelId: "gemini-4-argon" });
		expect(b.availableModels().map((g) => g.slotId)).toEqual(["google"]);
	});

	it("reports a clear error when every provider is switched off", async () => {
		const b = await newBackend();
		bind(b, "anthropic", "anthropic");
		const s = await b.openSession({ cwd: "/tmp" });
		b.unbindProvider("anthropic");
		expect(s.currentModel()).toBeUndefined();
		const r = await s.prompt("hi", () => {}, new AbortController().signal);
		expect(r).toMatchObject({ stop: "error" });
		expect(r.error).toContain("No model available");
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
