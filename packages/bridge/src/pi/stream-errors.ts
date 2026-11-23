// A response stream that breaks off mid-event is a transient failure: retry it like an interrupted stream.
//
// Seen through AIR's proxy: `event: content_block_delta` with an empty `data:` line. Pi's Anthropic client then fails
// with "Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input", which is not in Pi's
// list of retryable errors (pi-ai utils/retry.js), so the whole turn ended. The same cut is retried when it surfaces as
// "stream ended before message_stop". This extension rewords such a failed response at `message_end`, before Pi
// decides on a retry (agent-session `_handlePostAgentRun` reads the replaced message), so Pi's own retry (backoff,
// `retry.maxRetries`) repeats the request. The original text is kept in the message.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A stream event that could not be parsed: a cut-off or empty `data:` line. */
const UNPARSABLE_STREAM_EVENT = /Could not parse \S+ SSE event|Unexpected end of JSON input/i;

/** Wording Pi's retry policy recognises as an interrupted stream. */
export const RETRYABLE_PREFIX = "Stream was interrupted";

export function retryBrokenStreams(pi: ExtensionAPI): void {
	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return undefined;
		if (!UNPARSABLE_STREAM_EVENT.test(message.errorMessage) || message.errorMessage.startsWith(RETRYABLE_PREFIX)) return undefined;
		return { message: { ...message, errorMessage: `${RETRYABLE_PREFIX} (${message.errorMessage})` } };
	});
}
