// Stand-in for AIR's local LLM proxy: model listings (per route) + Anthropic Messages streaming.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: any;
}

export interface FakeProxyOptions {
	/** Answer for GET requests (model listings): return [status, json] or undefined for 404. */
	listing?: (path: string, req: FakeRequest) => [number, unknown] | undefined;
	/** Text the fake Anthropic model streams back. */
	reply?: (req: FakeRequest) => string;
}

export async function startFakeProxy(options: FakeProxyOptions = {}): Promise<{ url: string; requests: FakeRequest[]; close: () => Promise<void> }> {
	const requests: FakeRequest[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const fr: FakeRequest = { method: req.method ?? "GET", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
			requests.push(fr);
			const pathname = fr.path.split("?")[0];
			if (fr.method === "GET") {
				const answer = options.listing?.(pathname, fr);
				if (!answer) return void res.writeHead(404).end();
				res.writeHead(answer[0], { "content-type": "application/json" }).end(JSON.stringify(answer[1]));
				return;
			}
			if (!pathname.endsWith("/v1/messages") || !options.reply) return void res.writeHead(404).end();
			const text = options.reply(fr);
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

/** Listings shaped like the real ones; ids are a mix of known, dated and unknown models. */
export const LISTINGS = {
	anthropicVendor: { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-opus-5-5-20261001", display_name: "Claude Opus 5.5" }, { id: "claude-mystery-9" }], has_more: false },
	openaiAccount: {
		data: [
			{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", context_length: 400000, pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
			{ id: "gpt-6-luna", name: "GPT-6 Luna" },
			{ id: "gpt-image-9", name: "Image", architecture: { output_modalities: ["image"] } },
			{ id: "gpt-unknown-1", name: "Unknown" },
		],
	},
	googleVendor: { models: [{ name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }, { name: "models/gemini-4-argon" }, { name: "models/embedding-001" }] },
	vertexVendor: { publisherModels: [{ name: "publishers/google/models/gemini-3.8-flash@001" }] },
};
