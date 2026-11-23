/**
 * Eco planning in the message history (COST-06): the context fold that leaves the implementation model only the plan
 * (R12, R15), and the tools to restore when a saved session stopped mid-planning.
 */
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEvent, CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { CREATE_PLAN, IMPLEMENT_FROM_PLAN, PLAN_EXHAUSTED_ERROR, REPORT_PLAN } from "./prompts.ts";

type AgentMessage = ContextEvent["messages"][number];

/** Details of a successful create_plan result. */
export type CreatePlanDetails = {
	/** The tools that were active before planning. */
	activeTools: string[];
};

const PLAN_EXHAUSTED = "junie-cost-plan-exhausted";

/**
 * Hidden message that ends a planning which ran out of turns (R15). It lets the run continue even after a text-only
 * last planner turn, and the fold replaces the exploration before it with a create_plan error.
 */
export const PLAN_EXHAUSTED_MARKER: CustomMessageEntryDraft = {
	type: "custom_message",
	customType: PLAN_EXHAUSTED,
	content: PLAN_EXHAUSTED_ERROR,
	display: false,
};

/** Where a planning ends and what its create_plan result says instead of the planning instructions. */
type PlanningFold = { end: number; replacement: ToolResultMessage };

function isSuccessfulResult(message: AgentMessage, tool: string): message is ToolResultMessage {
	return message.role === "toolResult" && message.toolName === tool && !message.isError;
}

function isPlanExhausted(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PLAN_EXHAUSTED;
}

/** The trimmed `plan` argument of a report_plan call; empty for any other call. */
function reportedPlan(call: ToolCall): string {
	return call.name === REPORT_PLAN && typeof call.arguments.plan === "string" ? call.arguments.plan.trim() : "";
}

function withText(result: ToolResultMessage, text: string): ToolResultMessage {
	return { ...result, content: [{ type: "text", text }] };
}

/**
 * The end of the planning that starts with the successful create_plan result at `start`: the result of the first
 * report_plan call that has a plan and succeeded (R12), or the exhaustion marker (R15). Undefined while the planning
 * runs or when another create_plan call comes first.
 */
function findPlanningEnd(
	messages: AgentMessage[], start: number, createResult: ToolResultMessage,
): PlanningFold | undefined {
	for (let index = start + 1; index < messages.length; index++) {
		const message = messages[index];
		if (isPlanExhausted(message)) {
			return { end: index, replacement: { ...withText(createResult, PLAN_EXHAUSTED_ERROR), isError: true } };
		}
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.some((call) => call.name === CREATE_PLAN)) return undefined;
		for (const call of calls) {
			const plan = reportedPlan(call);
			if (!plan) continue;
			const end = messages.findIndex((result, resultIndex) => resultIndex > index
				&& isSuccessfulResult(result, REPORT_PLAN) && result.toolCallId === call.id);
			if (end >= 0) return { end, replacement: withText(createResult, `${plan}\n\n${IMPLEMENT_FROM_PLAN}`) };
		}
	}
	return undefined;
}

/** The planner's turns and tool results go; the user's clarifications and other custom messages stay. */
function keptInFold(message: AgentMessage): boolean {
	return message.role !== "assistant" && message.role !== "toolResult" && !isPlanExhausted(message);
}

/**
 * The context with every finished planning folded into its create_plan result: the accepted plan with the
 * implementation instructions (R12) or the exhaustion error (R15). Undefined when there is nothing to fold.
 */
export function foldPlanning(messages: AgentMessage[]): AgentMessage[] | undefined {
	const folded: AgentMessage[] = [];
	let changed = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const fold = isSuccessfulResult(message, CREATE_PLAN) ? findPlanningEnd(messages, index, message) : undefined;
		if (!fold) {
			folded.push(message);
			continue;
		}
		folded.push(fold.replacement, ...messages.slice(index + 1, fold.end + 1).filter(keptInFold));
		index = fold.end;
		changed = true;
	}
	return changed ? folded : undefined;
}

/**
 * The tools that were active before the last planning in `messages`, unless it accepted a plan. Pi restores the tool
 * set from the transcript, so a session saved mid-planning would otherwise resume with the planning tools (R15).
 */
export function toolsBeforeUnfinishedPlanning(messages: AgentMessage[]): string[] | undefined {
	let tools: string[] | undefined;
	for (const message of messages) {
		if (isSuccessfulResult(message, CREATE_PLAN)) {
			const details = message.details as Partial<CreatePlanDetails> | undefined;
			if (Array.isArray(details?.activeTools)) tools = details.activeTools;
		} else if (isSuccessfulResult(message, REPORT_PLAN)) {
			tools = undefined;
		}
	}
	return tools;
}
