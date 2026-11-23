import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findPackages, isEnabled, packageName, withEnabled } from "../src/packages.ts";

const junieCost = fileURLToPath(new URL("../../junie-cost", import.meta.url));

describe("package entries", () => {
	it("off is pi config's empty extensions filter; on removes it and keeps other filters", () => {
		expect(withEnabled("npm:pi-web-access", false)).toEqual({ source: "npm:pi-web-access", extensions: [] });
		expect(withEnabled({ source: "npm:x", extensions: [] }, true)).toBe("npm:x");
		expect(withEnabled({ source: "npm:x", extensions: [], skills: ["-a"] }, true)).toEqual({ source: "npm:x", skills: ["-a"] });
		expect(withEnabled({ source: "npm:x", skills: ["-a"] }, false)).toEqual({ source: "npm:x", skills: ["-a"], extensions: [] });
		expect(withEnabled("npm:x", true)).toBeUndefined();
		expect([isEnabled("npm:x"), isEnabled({ source: "npm:x", extensions: ["-src/a.ts"] }), isEnabled({ source: "npm:x", extensions: [] })]).toEqual([true, true, false]);
	});

	it("names packages and finds them by a unique part", () => {
		expect(packageName("npm:@tintinweb/pi-subagents@0.26.0", "/")).toBe("@tintinweb/pi-subagents");
		expect(packageName("npm:pi-web-access", "/")).toBe("pi-web-access");
		expect(packageName(junieCost, "/")).toBe("pi-junie-cost");
		const list = [
			{ scope: "user" as const, source: junieCost, name: "pi-junie-cost", enabled: true },
			{ scope: "user" as const, source: "/x/jetbrains-ai", name: "pi-junie-jetbrains-ai", enabled: true },
		];
		expect(findPackages(list, "cost").map((p) => p.name)).toEqual(["pi-junie-cost"]);
		expect(findPackages(list, "pi-junie")).toHaveLength(2);
		expect(findPackages(list, "nothing")).toEqual([]);
	});
});

describe("/plugins", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	});

	async function command(packages: unknown[]) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { default: pluginManager } = await import("../src/index.ts");
		let handler: (args: string, ctx: any) => Promise<void> = async () => {};
		pluginManager({ registerCommand: (_name: string, def: any) => (handler = def.handler) } as any);
		const notes: string[] = [];
		let reloads = 0;
		const cwd = mkdtempSync(join(tmpdir(), "proj-"));
		mkdirSync(join(cwd, ".pi"));
		const run = (args: string, pick?: (options: string[]) => string | undefined) =>
			handler(args, { cwd, hasUI: !!pick, ui: { notify: (m: string) => notes.push(m), select: async (_t: string, o: string[]) => pick?.(o) }, reload: async () => void reloads++ });
		const settings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).packages;
		return { run, settings, notes, reloads: () => reloads };
	}

	it("switches a package off and on by name, writing settings.json and reloading", async () => {
		const c = await command(["npm:pi-web-access", junieCost]);
		await c.run("off cost");
		expect(c.settings()).toEqual(["npm:pi-web-access", { source: junieCost, extensions: [] }]);
		expect(c.reloads()).toBe(1);
		await c.run("off cost");
		expect(c.notes.at(-1)).toBe("pi-junie-cost is already off.");
		await c.run("on pi-junie-cost");
		expect(c.settings()).toEqual(["npm:pi-web-access", junieCost]);
		expect(c.reloads()).toBe(2);
	});

	it("lists, and switches the package picked in the picker", async () => {
		const c = await command(["npm:pi-web-access", { source: junieCost, extensions: [] }]);
		await c.run("list");
		expect(c.notes.at(-1)).toBe("✓ on   pi-web-access\n✗ off  pi-junie-cost");
		await c.run("", (options) => options.find((o) => o.includes("pi-junie-cost")));
		expect(c.settings()).toEqual(["npm:pi-web-access", junieCost]);
		await c.run("off nothing-like-this");
		expect(c.notes.at(-1)).toBe('No installed package matches "nothing-like-this".');
	});
});
