// Stand-in for AIR's local LLM proxy: model listings (per route) + Anthropic Messages streaming.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: any;
}

/** A tool call (optionally after text); `also` adds more calls to the same message (parallel tool calls). */
export interface FakeToolReply {
	tool: string;
	input: unknown;
	text?: string;
	also?: { tool: string; input: unknown }[];
}

export interface FakeProxyOptions {
	/** Answer for GET requests (model listings): return [status, json] or undefined for 404. */
	listing?: (path: string, req: FakeRequest) => [number, unknown] | undefined;
	/** What the fake Anthropic model answers: text, or a tool call. */
	reply?: (req: FakeRequest) => string | FakeToolReply;
	/** Cut this request's stream after an event with an empty `data:` line (as AIR's proxy once did). */
	breakStream?: (req: FakeRequest) => boolean;
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
			const answer = options.reply(fr);
			const start: [string, unknown] = ["message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: fr.body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }];
			const body: [string, unknown][] =
				typeof answer === "string"
					? [
							["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
							...answer.split(/(?<= )/).map((part): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }]),
							["content_block_stop", { type: "content_block_stop", index: 0 }],
							["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 7 } }],
						]
					: [
							// optional text before the call (commentary)
							...(answer.text
								? ([
										["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
										["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer.text } }],
										["content_block_stop", { type: "content_block_stop", index: 0 }],
									] as [string, unknown][])
								: []),
							...[{ tool: answer.tool, input: answer.input }, ...(answer.also ?? [])].flatMap((call, i): [string, unknown][] => {
								const index = (answer.text ? 1 : 0) + i;
								const id = i === 0 ? `toolu_${requests.length}` : `toolu_${requests.length}_${i}`;
								return [
									["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: call.tool, input: {} } }],
									["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }],
									["content_block_stop", { type: "content_block_stop", index }],
								];
							}),
							["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 12, output_tokens: 7 } }],
						];
			const events: [string, unknown][] = [start, ...body, ["message_stop", { type: "message_stop" }]];
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (options.breakStream?.(fr)) {
				for (const [name, data] of events.slice(0, 3)) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
				res.end("event: content_block_delta\ndata: \n\n");
				return;
			}
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
	googleVendor: { models: [{ name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }, { name: "models/gemini-4-argon" }, { name: "models/gemini-4-carbon" }, { name: "models/gemini-2.5-pro" }, { name: "models/embedding-001" }] },
	vertexVendor: { publisherModels: [{ name: "publishers/google/models/gemini-3.8-flash@001" }] },
};
