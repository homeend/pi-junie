// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests: one read-only tool, one writing tool.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = [
	{
		name: "get_open_file",
		description: "Returns the file open in the editor",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: "reformat_file",
		description: "Reformats a file",
		inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return;
	switch (msg.method) {
		case "initialize":
			return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-ide", version: "1.0.0" } } });
		case "tools/list":
			return send({ id: msg.id, result: { tools } });
		case "tools/call": {
			if (process.env.MCP_CALL_LOG) appendFileSync(process.env.MCP_CALL_LOG, `${msg.params.name}\n`);
			const text = msg.params.name === "get_open_file" ? "src/Main.kt (line 12)" : `reformatted ${msg.params.arguments?.path}`;
			return send({ id: msg.id, result: { content: [{ type: "text", text }] } });
		}
		default:
			return send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
	}
});
