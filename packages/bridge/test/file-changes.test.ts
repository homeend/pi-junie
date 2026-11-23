// AIR's per-turn changed-files report (agentFileChangeReport), as Junie answers it.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpAgent } from "../src/acp/agent.ts";
import { decodeFileChangeReportRequest, encodeFileChangeReport } from "../src/acp/file-changes.ts";
import { PiBackend } from "../src/pi/backend.ts";
import { LISTINGS, startFakeProxy } from "./fake-proxy.ts";
import { MemoryWire } from "./harness.ts";

type Obj = Record<string, any>;
const report = (update: Obj) => update._meta.jetbrains.air.agentFileChangeReport;

describe("changed-files report: wire", () => {
	it("accepts exactly Junie's request shape", () => {
		const meta = (request: unknown) => ({ jetbrains: { air: { agentFileChangeReportRequest: request } } });
		expect(decodeFileChangeReportRequest(meta({ version: 1, requestId: "r1" }))).toBe("r1");
		expect(decodeFileChangeReportRequest(meta({ version: 2, requestId: "r1" }))).toBeUndefined();
		expect(decodeFileChangeReportRequest(meta({ version: 1, requestId: "r1", extra: true }))).toBeUndefined();
		expect(decodeFileChangeReportRequest(meta({ version: 1, requestId: " " }))).toBeUndefined();
		expect(decodeFileChangeReportRequest(undefined)).toBeUndefined();
	});

	it("keeps canonical paths inside the session's folders, once each, within AIR's limits", () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "proj-")));
		const extra = realpathSync(mkdtempSync(join(tmpdir(), "extra-")));
		writeFileSync(join(project, "a.txt"), "");
		const link = join(tmpdir(), `proj-link-${Date.now()}`);
		symlinkSync(project, link);
		const update = encodeFileChangeReport("r1", [join(project, "a.txt"), join(link, "a.txt"), join(extra, "b.txt"), "/etc/passwd", `${project}-other/x`], [link, extra]);
		expect(update).toEqual({
			sessionUpdate: "session_info_update",
			_meta: { jetbrains: { air: { version: 1, agentFileChangeReport: expect.any(Object) } } },
		});
		expect(report(update)).toEqual({
			version: 1,
			requestId: "r1",
			status: "reported",
			paths: [join(project, "a.txt"), join(extra, "b.txt")],
			declaredComplete: false,
			truncated: false,
			uncertainty: "Non-edit writes and transient create/delete paths may be missing.",
		});
		const many = Array.from({ length: 1100 }, (_, i) => join(project, `f${i}.txt`));
		const capped = report(encodeFileChangeReport("r2", many, [project]));
		expect([capped.paths.length, capped.truncated]).toEqual([1024, true]);
	});
});

const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
const proxy = await startFakeProxy({
	listing: (path) => (path.endsWith("/v1/models") ? [200, LISTINGS.anthropicVendor] : undefined),
	reply: (req) =>
		JSON.stringify(req.body.messages).includes("tool_result")
			? "Done."
			: {
					tool: "write",
					input: { path: "a.txt", content: "new\n" },
					also: [
						{ tool: "edit", input: { path: "sub/b.txt", edits: [{ oldText: "old", newText: "changed" }] } },
						{ tool: "write", input: { path: "same.txt", content: "same\n" } },
						{ tool: "bash", input: { command: "touch c.txt" } },
						{ tool: "write", input: { path: join(outside, "x.txt"), content: "x" } },
					],
				},
});
afterAll(() => proxy.close());

async function connect(capabilities: string[]) {
	const backend = await PiBackend.create({ stateDir: mkdtempSync(join(tmpdir(), "pi-junie-test-")) });
	const wire = new MemoryWire();
	wire.clientHandler = (method) => (method === "session/request_permission" ? { outcome: { outcome: "selected", optionId: "allow_once" } } : {});
	new AcpAgent(wire.agentTransport, backend);
	let id = 0;
	const call = (method: string, params: Obj = {}) => wire.send({ jsonrpc: "2.0", id: ++id, method, params }, 20000) as Promise<Obj>;
	const init = await call("initialize", { protocolVersion: 1, clientInfo: { name: "client" }, clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities } } } } });
	await call("providers/set", { providerId: "anthropic", apiType: "anthropic", baseUrl: `${proxy.url}/a`, headers: {} });
	await backend.modelsSettled(5000);
	const project = realpathSync(mkdtempSync(join(tmpdir(), "pi-junie-proj-")));
	mkdirSync(join(project, "sub"));
	writeFileSync(join(project, "sub", "b.txt"), "old\n");
	writeFileSync(join(project, "same.txt"), "same\n");
	const { result } = await call("session/new", { cwd: project, mcpServers: [] });
	const reports = () => wire.sent.filter((m) => m.method === "session/update" && (m.params as Obj).update._meta?.jetbrains?.air?.agentFileChangeReport).map((m) => report((m.params as Obj).update));
	return { call, init, project, sessionId: result.sessionId as string, reports };
}

describe("changed-files report in a turn", () => {
	it("reports the files the edit tools changed, when AIR asks", async () => {
		const { call, init, project, sessionId, reports } = await connect(["agentFileChangeReport"]);
		expect(init.result._meta.jetbrains.air.capabilities).toContain("agentFileChangeReport");
		await call("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "change things" }],
			_meta: { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: "turn-1" } } } },
		});
		const [r] = reports();
		expect(r.requestId).toBe("turn-1");
		// unchanged same.txt, the bash-created c.txt and the file outside the project are not reported
		expect([...r.paths].sort()).toEqual([join(project, "a.txt"), join(project, "sub", "b.txt")]);

		// no request, no report
		await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
		expect(reports()).toHaveLength(1);
	});

	it("sends nothing to a client that does not take reports", async () => {
		const { call, sessionId, reports } = await connect([]);
		await call("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "change things" }],
			_meta: { jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId: "turn-1" } } } },
		});
		expect(reports()).toEqual([]);
	});
});
