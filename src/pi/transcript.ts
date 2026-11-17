// One Pi session's live events -> neutral transcript events (text with phases, thoughts, tool updates). Used for the
// session's own turns and for subagent child sessions, so both read the same.

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TurnSink } from "../core/ports.ts";
import { PhaseSplitter, type PhaseSplitterOptions, signaturePhase } from "./phases.ts";
import { ToolTracker } from "./tools.ts";

export interface TranscriptOptions {
	cwd: string;
	phaseHold?: PhaseSplitterOptions;
	/** Whether a tool waits for the user's approval before it runs (it stays pending until `approved`). */
	needsApproval: (toolName: string) => boolean;
	/** Tools that start subagents (their updates are marked `launchesSubagent`). */
	launchesSubagent?: (toolName: string) => boolean;
	/** Diagnostics for tool starts and ends. */
	log?: (line: string) => void;
}

export class TranscriptStream {
	private readonly tools: ToolTracker;
	private readonly phases: PhaseSplitter;
	private readonly sink: TurnSink;
	private readonly options: TranscriptOptions;

	constructor(sink: TurnSink, options: TranscriptOptions) {
		this.sink = sink;
		this.options = options;
		this.tools = new ToolTracker(options.cwd);
		this.phases = new PhaseSplitter((delta, phase) => sink({ kind: "text", delta, phase }), options.phaseHold);
	}

	/** Translates one Pi event; events that are not transcript (usage, lifecycle) are ignored. */
	handle(event: AgentSessionEvent): void {
		const log = this.options.log;
		if (event.type === "message_start" && event.message.role === "assistant") this.phases.messageStart();
		if (event.type === "message_update") {
			const e = event.assistantMessageEvent;
			if (e.type === "text_delta") this.phases.text(e.delta);
			else if (e.type === "text_end") {
				const block = e.partial.content[e.contentIndex] as { textSignature?: string } | undefined;
				this.phases.textEnd(signaturePhase(block?.textSignature));
			} else if (e.type === "thinking_delta") this.sink({ kind: "thought", delta: e.delta });
			else if (e.type === "toolcall_start") this.phases.toolCall();
			else if (e.type === "toolcall_end") this.tool(this.tools.requested(e.toolCall.id, e.toolCall.name, e.toolCall.arguments));
		} else if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") && (event as { parentToolCallId?: string }).parentToolCallId) {
			// nested call (reported through its parent tool's card)
		} else if (event.type === "tool_execution_start") {
			log?.(`tool ${event.toolName} ${event.toolCallId} start ${JSON.stringify(event.args).slice(0, 200)}`);
			this.tool(this.tools.started(event.toolCallId, event.toolName, event.args, this.options.needsApproval(event.toolName)));
		} else if (event.type === "tool_execution_update") {
			this.tool(this.tools.progressed(event.toolCallId, event.toolName, event.partialResult));
		} else if (event.type === "tool_execution_end") {
			log?.(`tool ${event.toolName} ${event.toolCallId} ${event.isError ? "FAILED" : "done"}${event.durationMs !== undefined ? ` ${event.durationMs}ms` : ""}`);
			this.tool(this.tools.finished(event.toolCallId, event.toolName, event.result, event.isError));
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.phases.messageEnd();
		}
	}

	/** An approved tool runs now. */
	approved(toolCallId: string, toolName: string): void {
		this.tool(this.tools.approved(toolCallId, toolName));
	}

	/** Shows text still held back (an aborted or failed message still shows what it wrote). */
	flush(): void {
		this.phases.messageEnd();
	}

	private tool(update: ReturnType<ToolTracker["finished"]> | undefined): void {
		if (!update) return;
		if (this.options.launchesSubagent?.(update.name)) update.launchesSubagent = true;
		this.sink({ kind: "tool", update });
	}
}
