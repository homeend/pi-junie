// A response stream cut off with an empty event (`data:` with nothing) is retried, not the end of the turn.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

let posts = 0;
const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: () => "Recovered answer.",
	breakStream: () => ++posts === 1, // the first answer breaks off, the retry is whole
});
afterAll(() => proxy.close());

describe("broken response streams", () => {
	it("retries a stream cut off with an unparsable event and finishes the turn", async () => {
		const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
		backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
		await backend.modelsSettled(3000);
		const session = await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")) });
		let text = "";
		const result = await session.prompt({ text: "hi", images: [] }, (e) => { if (e.kind === "text") text += e.delta; }, new AbortController().signal, async () => "allow_once");
		expect(result.stop).toBe("end_turn");
		expect(text).toContain("Recovered answer.");
		expect(proxy.requests.filter((r) => r.method === "POST")).toHaveLength(2);
	}, 30000);
});
