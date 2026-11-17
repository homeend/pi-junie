// Tiny stand-in for AIR's LLM proxy speaking the Anthropic Messages streaming API.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	path: string;
	headers: IncomingHttpHeaders;
	body: { model: string; messages: { role: string; content: unknown }[]; system?: unknown };
}

export async function startFakeAnthropic(reply: (req: FakeRequest) => string): Promise<{ url: string; requests: FakeRequest[]; close: () => Promise<void> }> {
	const requests: FakeRequest[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const fr: FakeRequest = { path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") };
			requests.push(fr);
			if (!fr.path.split("?")[0].endsWith("/v1/messages")) {
				res.writeHead(404).end();
				return;
			}
			const text = reply(fr);
			const events: [string, unknown][] = [
				["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: fr.body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }],
				["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
				...text.split(/(?<= )/).map((part): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }]),
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 7 } }],
				["message_stop", { type: "message_stop" }],
			];
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
