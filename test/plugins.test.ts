// Plugins installed with `pi install` in the user's Pi agent dir are detected and loaded into bridge sessions.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi/backend.ts";
import { detectPlugins, SUBAGENTS_PLUGIN } from "../src/pi/plugins.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";

const proxy = await startFakeProxy({
	reply: () => "done",
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
});
afterAll(() => proxy.close());

/** A Pi agent dir with a stand-in subagents package where `pi install npm:<name>` puts it. */
function piAgentDirWithSubagents(version = "0.26.0"): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-junie-piagent-"));
	const pkg = join(agentDir, "npm", "node_modules", SUBAGENTS_PLUGIN);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: SUBAGENTS_PLUGIN, version, pi: { extensions: ["./index.ts"], skills: ["./skills"] } }));
	mkdirSync(join(pkg, "skills", "workflow-authoring"), { recursive: true });
	writeFileSync(join(pkg, "skills", "workflow-authoring", "SKILL.md"), "---\nname: workflow-authoring\ndescription: Write SubagentWorkflow scripts.\n---\nUse SubagentWorkflow.\n");
	writeFileSync(
		join(pkg, "index.ts"),
		`export default function (pi) {
			pi.registerTool({
				name: "Agent", label: "Agent", description: "Launch a subagent",
				parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
				async execute() { return { content: [{ type: "text", text: "child done" }], details: {} }; },
			});
		}`,
	);
	return agentDir;
}

async function toolsSentToModel(piAgentDir?: string): Promise<string[]> {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")), piAgentDir });
	backend.bindProvider({ slotId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(3000);
	const session = await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")) });
	proxy.requests.length = 0;
	await session.prompt({ text: "hi", images: [] }, () => {}, new AbortController().signal, async () => "allow_once");
	const post = proxy.requests.find((r) => r.method === "POST");
	return (post?.body.tools ?? []).map((t: { name: string }) => t.name);
}

describe("Pi plugins", () => {
	it("detects the subagents plugin where `pi install` puts it, with its version", () => {
		expect(detectPlugins(piAgentDirWithSubagents("0.27.1"))).toEqual([
			expect.objectContaining({ name: SUBAGENTS_PLUGIN, version: "0.27.1" }),
		]);
		expect(detectPlugins(mkdtempSync(join(tmpdir(), "pi-junie-piagent-")))).toEqual([]);
	});

	it("loads an installed subagents plugin into sessions and reports it to the compat layer", async () => {
		const piAgentDir = piAgentDirWithSubagents();
		const stateDir = mkdtempSync(join(tmpdir(), "pi-junie-test-"));
		const backend = await PiBackend.create({ stateDir, piAgentDir });
		// the plugin's saved children stay in the bridge's state dir, not in Pi's session list the IDE shows
		expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(stateDir, "subagents"));
		expect(backend.installedPlugins()).toEqual([{ name: SUBAGENTS_PLUGIN, version: "0.26.0" }]);
		expect(await toolsSentToModel(piAgentDir)).toContain("Agent");
		// the plugin's own skills (for tools the bridge leaves off) are not offered
		const session = await backend.openSession({ cwd: mkdtempSync(join(tmpdir(), "pi-junie-proj-")) });
		expect((await session.commands()).map((c) => c.name)).not.toContain("workflow-authoring");
	});

	it("the welcome message says whether subagents are available", async () => {
		const stateDir = () => mkdtempSync(join(tmpdir(), "pi-junie-test-"));
		const withPlugin = await PiBackend.create({ stateDir: stateDir(), piAgentDir: piAgentDirWithSubagents(), welcome: true });
		expect(withPlugin.welcome()).toContain(`**Subagents: available** (\`${SUBAGENTS_PLUGIN}\` 0.26.0)`);
		const without = await PiBackend.create({ stateDir: stateDir(), piAgentDir: mkdtempSync(join(tmpdir(), "pi-junie-piagent-")), welcome: true });
		expect(without.welcome()).toContain(`**Subagents: not available** (install with \`pi install npm:${SUBAGENTS_PLUGIN}\``);
		expect((await PiBackend.create({ stateDir: stateDir() })).welcome()).toBeUndefined();
	});

	it("without the plugin sessions have no subagent tool", async () => {
		expect(await toolsSentToModel(undefined)).not.toContain("Agent");
	});
});
