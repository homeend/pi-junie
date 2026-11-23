// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests: one read-only tool, one writing tool.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const router = {
	name: "execute_tool",
	description: "Universal tool executor that can invoke specific IDE MCP tool dynamically.",
	inputSchema: { type: "object", properties: { command: { type: "string", description: "Command-line string with tool name and arguments" } }, required: ["command"] },
};
// MCP_ROUTER=1: behave like AIR's jetbrains_air_ide server (only the router)
const tools = process.env.MCP_ROUTER === "1" ? [router] : [
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
			if (msg.params.name === "execute_tool") {
				const [tool, ...rest] = String(msg.params.arguments?.command ?? "").split(/\s+/);
				if (tool !== "get_file_problems") return send({ id: msg.id, result: { content: [{ type: "text", text: `Tool '${tool}' not found` }], isError: true } });
				return send({ id: msg.id, result: { content: [{ type: "text", text: `no problems in ${rest[1]}` }] } });
			}
			const text = msg.params.name === "get_open_file" ? "src/Main.kt (line 12)" : `reformatted ${msg.params.arguments?.path}`;
			return send({ id: msg.id, result: { content: [{ type: "text", text }] } });
		}
		default:
			return send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
	}
});
