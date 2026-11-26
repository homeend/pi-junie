// Enforces the bridge boundaries described in docs/spec.md §3.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
function imports(dir: string): { file: string; spec: string }[] {
	return readdirSync(join(SRC, dir), { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile() && d.name.endsWith(".ts"))
		.flatMap((d) => {
			const file = join(d.parentPath, d.name);
			return [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => ({ file, spec: m[1] }));
		});
}

/** Imports of every other package in the workspace (packages/<name>/src). */
function otherPackages(): { file: string; spec: string }[] {
	const packages = join(SRC, "..", "..");
	return readdirSync(packages, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name !== "bridge")
		.flatMap((d) => {
			try {
				return imports(join("..", "..", d.name, "src"));
			} catch {
				return []; // a package without src/
			}
		});
}

describe("architecture boundaries", () => {
	it("no other package imports the bridge (they must work in plain Pi)", () => {
		const all = otherPackages();
		expect(all.length).toBeGreaterThan(0);
		for (const i of all) expect(i.spec, i.file).not.toMatch(/^pi-junie(\/|$)|(^|\/)bridge(\/|$)/);
	});
	it("core depends on nothing but itself", () => {
		for (const i of imports("core")) expect(i.spec, i.file).toMatch(/^\.\/|^node:/);
	});
	it("acp driver never touches Pi", () => {
		for (const i of imports("acp")) expect(i.spec, i.file).not.toMatch(/@earendil-works|\/pi\//);
	});
	it("pi bridge never touches ACP", () => {
		for (const i of imports("pi")) expect(i.spec, i.file).not.toMatch(/agentclientprotocol|\/acp\//);
	});
	it("compat is standalone", () => {
		for (const i of imports("compat")) expect(i.spec, i.file).toMatch(/^\.\/|^node:/);
	});
});
