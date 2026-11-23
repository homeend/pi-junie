// Splits an assistant message's streamed text into "commentary" (written while working, before tool calls)
// and "final_answer", like Junie's message phases. Neutral: no ACP here.
//
// While text streams we cannot know yet whether the message ends with tool calls. Commentary is typically a
// short sentence right before a tool call, so the first text of a message is held back briefly:
// - a tool call starts while held -> it was commentary;
// - the provider names the phase (OpenAI Responses, at the end of a text block) -> that phase;
// - the hold time or size runs out, or the message ends -> final answer, streamed from then on.

import type { MessagePhase } from "../core/types.ts";

export interface PhaseSplitterOptions {
	holdMs?: number;
	holdChars?: number;
}

export class PhaseSplitter {
	private held = "";
	private phase?: MessagePhase;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly holdMs: number;
	private readonly holdChars: number;
	private readonly emit: (delta: string, phase: MessagePhase) => void;

	constructor(emit: (delta: string, phase: MessagePhase) => void, options: PhaseSplitterOptions = {}) {
		this.emit = emit;
		this.holdMs = options.holdMs ?? 1500;
		this.holdChars = options.holdChars ?? 600;
	}

	/** A new assistant message begins. */
	messageStart(): void {
		this.flush("final_answer");
		this.phase = undefined;
	}

	text(delta: string): void {
		if (!delta) return;
		if (this.phase) return this.emit(delta, this.phase);
		this.held += delta;
		if (this.held.length >= this.holdChars) this.decide("final_answer");
		else this.timer ??= setTimeout(() => this.decide("final_answer"), this.holdMs);
	}

	/** The message calls a tool: text held so far was commentary; later text in it is commentary too. */
	toolCall(): void {
		if (!this.phase) this.decide("commentary");
	}

	/** End of a text block; some providers name its phase. */
	textEnd(phase: MessagePhase | undefined): void {
		if (phase && !this.phase) this.decide(phase);
	}

	/** The message (or the turn) ended: whatever is still held was the answer. */
	messageEnd(): void {
		this.flush("final_answer");
	}

	private decide(phase: MessagePhase): void {
		this.phase = phase;
		this.flush(phase);
	}

	private flush(phase: MessagePhase): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.held) this.emit(this.held, this.phase ?? phase);
		this.held = "";
	}
}

/** The phase OpenAI Responses records in a text block's signature (Pi stores `{v:1, id, phase}`), if any. */
export function signaturePhase(signature: string | undefined): MessagePhase | undefined {
	if (!signature?.startsWith("{")) return undefined;
	try {
		const phase = (JSON.parse(signature) as { phase?: unknown }).phase;
		return phase === "commentary" || phase === "final_answer" ? phase : undefined;
	} catch {
		return undefined;
	}
}
