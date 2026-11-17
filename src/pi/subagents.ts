// Subagents from the @tintinweb/pi-subagents plugin, mirrored as neutral child sessions.
//
// The plugin runs each subagent as an in-process Pi AgentSession (createAgentSession + bindExtensions) inside the
// parent's `Agent` tool call. The bridge adopts those sessions without patching the plugin:
// - every AgentSession.bindExtensions in the process is observed (one prototype hook, installed once);
// - a session bound while a bridge turn runs (AsyncLocalStorage scope) and not created by the bridge itself is a
//   child of that turn's session;
// - the child's events become `subagent_update` events (same translation as the parent's own transcript), its tool
//   calls pass the parent's permission gate (wrapped around Pi's beforeToolCall hook, after the plugin's own), and
//   it is announced (`subagent_spawned`) with the name and task of the `Agent` call that started it.

import { AsyncLocalStorage } from "node:async_hooks";
import { AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../core/log.ts";
import type { TurnSink } from "../core/ports.ts";
import type { SubagentState } from "../core/types.ts";
import type { PhaseSplitterOptions } from "./phases.ts";
import { TranscriptStream } from "./transcript.ts";

/** The plugin's tool that starts a subagent. */
export const AGENT_TOOL = "Agent";

/** Adopts child sessions created while a turn runs. */
export interface ChildHost {
	adopt(child: AgentSession): void;
}

const scope = new AsyncLocalStorage<ChildHost>();
const bridgeSessions = new WeakSet<AgentSession>();
let hookInstalled = false;

/** Observes AgentSession.bindExtensions process-wide; idempotent. */
export function installChildSessionHook(): void {
	if (hookInstalled) return;
	hookInstalled = true;
	const original = AgentSession.prototype.bindExtensions;
	AgentSession.prototype.bindExtensions = async function (this: AgentSession, ...args: Parameters<AgentSession["bindExtensions"]>) {
		const host = scope.getStore();
		await original.apply(this, args);
		if (host && !bridgeSessions.has(this)) host.adopt(this);
	};
}

/** A session the bridge created for a client session (never adopted as a child). */
export function markBridgeSession(session: AgentSession): void {
	bridgeSessions.add(session);
}

/** Runs `fn` so that child sessions created inside it are adopted by `host`. */
export function withChildHost<T>(host: ChildHost, fn: () => Promise<T>): Promise<T> {
	return scope.run(host, fn);
}

/** The gate's verdict for a child's tool call: undefined runs it (after approval when it needed one). */
export type ChildGate = (subagentId: string, call: { toolCallId: string; toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>;

export interface RelayOptions {
	parentId: string;
	cwd: string;
	sink: TurnSink;
	gate: ChildGate;
	needsApproval: (toolName: string) => boolean;
	phaseHold?: PhaseSplitterOptions;
	log: Logger;
}

interface AgentCall {
	toolCallId: string;
	input: Record<string, unknown>;
	child?: Child;
}

interface Child {
	id: string;
	session: AgentSession;
	transcript: TranscriptStream;
	announced: boolean;
	finished: boolean;
	call?: AgentCall;
	unsubscribe: () => void;
}

let childCounter = 0;

/** One parent turn's subagents: matches `Agent` calls to the child sessions they start and mirrors the children. */
export class SubagentRelay implements ChildHost {
	private readonly options: RelayOptions;
	private readonly calls: AgentCall[] = [];
	private readonly children: Child[] = [];

	constructor(options: RelayOptions) {
		this.options = options;
	}

	/** The parent started an `Agent` call (its child session follows). */
	agentCallStarted(toolCallId: string, input: unknown): void {
		this.calls.push({ toolCallId, input: (input ?? {}) as Record<string, unknown> });
	}

	/** The parent's `Agent` call returned: its child is done. */
	agentCallEnded(toolCallId: string, isError: boolean, aborted: boolean): void {
		const call = this.calls.find((c) => c.toolCallId === toolCallId);
		if (call?.child) this.finish(call.child, aborted ? "cancelled" : isError ? "failed" : "completed");
	}

	/** The turn ended: children still open end with it. */
	close(aborted: boolean): void {
		for (const child of this.children) this.finish(child, aborted ? "cancelled" : "completed");
	}

	adopt(session: AgentSession): void {
		const { log, parentId } = this.options;
		const id = `${parentId}:subagent-${++childCounter}`;
		const sink: TurnSink = (event) => this.options.sink({ kind: "subagent_update", subagentId: id, event });
		const transcript = new TranscriptStream(sink, {
			cwd: session.sessionManager.getCwd(),
			phaseHold: this.options.phaseHold,
			needsApproval: this.options.needsApproval,
			log: (line) => log.info(`session ${parentId} subagent ${id}: ${line}`),
		});
		const child: Child = { id, session, transcript, announced: false, finished: false, unsubscribe: () => {} };
		this.children.push(child);
		log.info(`session ${parentId}: subagent ${id} adopted (Pi session ${session.sessionId}, model ${session.model?.provider}/${session.model?.id})`);

		// The parent's permission gate, after the plugin's own tool_call handlers (which may block first).
		const pluginHook = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (context, signal) => {
			const earlier = pluginHook ? await pluginHook(context, signal) : undefined;
			if (earlier?.block) return earlier;
			const call = { toolCallId: context.toolCall.id, toolName: context.toolCall.name, input: (context.args ?? {}) as Record<string, unknown> };
			const verdict = await this.options.gate(id, call);
			if (verdict) return verdict;
			if (this.options.needsApproval(call.toolName)) transcript.approved(call.toolCallId, call.toolName);
			return earlier;
		};

		child.unsubscribe = session.subscribe((event) => this.onChildEvent(child, event));
	}

	private onChildEvent(child: Child, event: AgentSessionEvent): void {
		if (child.finished) return;
		if (!child.announced && event.type === "message_start" && event.message.role === "user") {
			this.announce(child, messageText(event.message.content));
			return;
		}
		if (!child.announced) {
			if (event.type !== "message_update" && event.type !== "tool_execution_start") return;
			this.announce(child, "");
		}
		child.transcript.handle(event);
		// A child no Agent call claimed (e.g. started by another tool) ends with its run.
		if (event.type === "agent_end" && !child.call) {
			const last = [...event.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
			this.finish(child, last?.stopReason === "error" ? "failed" : last?.stopReason === "aborted" ? "cancelled" : "completed");
		}
	}

	/** Announces the child with its `Agent` call: the one whose prompt the child received, else the oldest unclaimed. */
	private announce(child: Child, firstMessage: string): void {
		const open = this.calls.filter((c) => !c.child);
		const call = open.find((c) => typeof c.input.prompt === "string" && c.input.prompt && firstMessage.includes(c.input.prompt)) ?? open[0];
		if (call) {
			call.child = child;
			child.call = call;
		}
		const input = call?.input ?? {};
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const type = str(input.subagent_type);
		const name = str(input.name) ?? type ?? "Subagent";
		const prompt = str(input.prompt) ?? (firstMessage.trim() || undefined);
		const task = str(input.description) ?? prompt?.split("\n")[0]?.slice(0, 120) ?? name;
		child.announced = true;
		this.options.log.info(`session ${this.options.parentId}: subagent ${child.id} spawned name=${JSON.stringify(name)} task=${JSON.stringify(task)}${call ? ` by ${call.toolCallId}` : ""}`);
		this.options.sink({ kind: "subagent_spawned", subagentId: child.id, name, task, ...(prompt ? { prompt } : {}) });
	}

	private finish(child: Child, state: SubagentState): void {
		if (child.finished) return;
		if (!child.announced) this.announce(child, "");
		child.transcript.flush();
		child.finished = true;
		child.unsubscribe();
		this.options.log.info(`session ${this.options.parentId}: subagent ${child.id} ${state}`);
		this.options.sink({ kind: "subagent_finished", subagentId: child.id, state });
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}
