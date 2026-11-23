/**
 * Eco planning (COST-06): `create_plan` turns the start of a task into a read-only planning phase of the main session,
 * and `report_plan` hands the plan over to the implementation. Junie runs this phase in a child planner
 * (docs/research/junie-model-mix.md). `history.ts` folds the finished planning out of the context.
 *
 * The planner keeps the phase of the current task between Pi events and, after the plan, the failed turns of the
 * implementation model. The router reads them to send a request to the cheap model only while the task implements an
 * accepted plan and the cheap model is not stuck. The handlers are subscribed in the package's index.ts, which says
 * why each of them is needed.
 *
 * Junie sources cite `path:line` in Junie origin/main de451b0f75 (2026-11-21), with `agent/` for
 * `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent`.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AgentToolResult, type BeforeAgentStartEvent, type BeforeProviderRequestEvent, type ContextEvent, defineTool,
	type ExtensionAPI, type ExtensionContext, isToolCallEventType, type MessageEndEvent, type SessionStartEvent,
	type Theme, type ToolCallEvent, type ToolResultEvent, type ToolResultEventResult, type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type CreatePlanDetails, foldPlanning, PLAN_EXHAUSTED_MARKER, toolsBeforeUnfinishedPlanning,
} from "./history.ts";
import {
	CREATE_PLAN, CREATE_PLAN_DESCRIPTION, ECO_MODEL_REQUIRED_ERROR, EMPTY_PLAN_ERROR, IMPLEMENT_FROM_PLAN,
	MODEL_MIX_GUIDANCE, MODEL_MIX_NO_PLAN_GUIDANCE, NO_ACTIVE_PLANNING_ERROR, OUT_OF_TURNS_WARNING,
	PLAN_ALREADY_USED_ERROR, PLAN_PARAMETER_DESCRIPTION, PLANNING_INSTRUCTIONS, READ_ONLY_ERROR, REPORT_PLAN,
	REPORT_PLAN_DESCRIPTION, SUMMARY_PARAMETER_DESCRIPTION,
} from "./prompts.ts";
import { isEcoModel } from "./router.ts";

// Completed planner turns before planning gives up (R7).
const MAX_PLANNER_TURNS = 50;
// Once this many turns are completed, exploration results carry Junie's out-of-turns warning.
const WARN_AFTER_TURNS = MAX_PLANNER_TURNS - 5;
// The request after this many completed turns is the last one: it offers only report_plan and, where the provider
// supports named tool choice, requires it.
const FORCE_REPORT_AFTER_TURNS = MAX_PLANNER_TURNS - 1;

// Failed implementation turns in a row before one request goes to the primary model (R14). Junie gives the rest of a
// step to the primary model after three failed attempts of the implementation model
// (agent/ActionRequestProducerLoop.kt:653–661, agent/modelmix/ModelMixContext.kt:53); Pi has no attempts within a
// step, so whole turns count.
const MAX_FAILED_TURNS = 3;

// Like Junie, the transcript shows one short line per planning tool instead of the planning prompt or the whole plan:
// "Planning…" when planning starts and "● <summary>" once the plan is reported; the full text is shown when the
// row is expanded.
const PLANNING_LABEL = "Planning…";
const WRITING_PLAN_LABEL = "Writing the plan…";
const PLAN_SUMMARY_LENGTH = 200;

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
}

// The first line of the plan's Goal section, or its first non-heading line when the plan has no Goal; used when the
// model gave no summary.
function planSummary(plan: string): string {
	const lines = plan.split("\n").map((line) => line.trim());
	const goal = lines.findIndex((line) => /^#+\s*goal\b/i.test(line));
	const summary = lines.slice(goal + 1).find((line) => line && !line.startsWith("#"))?.replace(/^[-*]\s*/, "") ?? "";
	return summary.length > PLAN_SUMMARY_LENGTH ? `${summary.slice(0, PLAN_SUMMARY_LENGTH - 1)}…` : summary;
}

function reportedSummary(args: { plan?: unknown; summary?: unknown } | undefined): string {
	const summary = typeof args?.summary === "string" ? args.summary.trim().replace(/\s+/g, " ") : "";
	return summary || planSummary(typeof args?.plan === "string" ? args.plan : "");
}

// The rows draw their own one-line shell (no background box) at Pi's text padding.
function row(text: string): Text {
	return new Text(text, 1, 0);
}

function renderPlanningResult(text: string, expanded: boolean, isError: boolean, theme: Theme): Text {
	if (isError) return row(theme.fg("error", text));
	return row(expanded && text ? theme.fg("muted", text) : "");
}

/**
 * The provider payload of the last planner request, changed to require report_plan through named tool choice (R7);
 * undefined leaves the payload as it is.
 */
function forceReportPlan(payload: unknown): unknown {
	const request = payload as { model?: string; input?: unknown; tools?: { name?: string }[] } | undefined;
	if (!request?.tools?.some((tool) => tool.name === REPORT_PLAN)) return undefined;
	// OpenAI Responses API.
	if ("input" in request) return { ...request, tool_choice: { type: "function", name: REPORT_PLAN } };
	// Of the Claude Eco planners, only Opus 5 supports forced choice. Junie omits thinking on that request.
	if (request.model === "claude-opus-5") {
		return { ...request, thinking: undefined, tool_choice: { type: "tool", name: REPORT_PLAN } };
	}
	return undefined;
}

/** R14: every tool call of the turn returned an error, or the response has neither tool calls nor text. */
function turnFailed({ message, toolResults }: TurnEndEvent): boolean {
	// Pi gives every tool call of a completed turn a result, an error one when the call did not run.
	if (toolResults.length > 0) return toolResults.every((result) => result.isError);
	if (message.role !== "assistant") return false;
	return !message.content.some((block) => block.type === "text" && block.text.trim() !== "");
}

/**
 * Phase of the current task; a task plans at most once (R5). An accepted plan makes the task `implementing`, and the
 * router sends it to the implementation model (R11). Planning that ends without a plan, or a user message after the
 * plan, leaves the task `used`, on the primary model (R3, R15).
 */
type PlannerState =
	| { phase: "idle" }
	| {
		phase: "planning";
		/** The create_plan call that started planning; any other create_plan call is a repeat. */
		callId: string;
		/** The tools that were active before planning; they come back when it ends. */
		toolsBefore: string[];
		/** Completed planner turns (R7). */
		turns: number;
	}
	| {
		phase: "implementing";
		/** Failed implementation turns in a row; after MAX_FAILED_TURNS one request goes to the primary model (R14). */
		failedTurns: number;
	}
	| { phase: "used" };

/** The planning tools and the handlers of one Pi session. */
export function createModelMixPlanner(pi: ExtensionAPI) {
	let state: PlannerState = { phase: "idle" };

	function setActiveToolsIfChanged(names: string[]): void {
		const active = pi.getActiveTools();
		const changed = active.length !== names.length || active.some((name, index) => name !== names[index]);
		if (changed) pi.setActiveTools(names);
	}

	// Junie removes the EDIT group during planning; creating new files stays allowed. Pi's write also overwrites, so
	// handleToolCall allows it only for paths that do not exist yet.
	function startPlanning(callId: string): void {
		const toolsBefore = pi.getActiveTools().filter((name) => name !== REPORT_PLAN);
		state = { phase: "planning", callId, toolsBefore, turns: 0 };
		setActiveToolsIfChanged([...toolsBefore.filter((name) => name !== "edit" && name !== CREATE_PLAN), REPORT_PLAN]);
	}

	/**
	 * The plan was accepted (`implementing`) or the turns ran out (`used`): the task goes on with the saved tools except
	 * the planning ones.
	 */
	function finishPlanning(next: "implementing" | "used"): void {
		if (state.phase !== "planning") return;
		setActiveToolsIfChanged(state.toolsBefore.filter((name) => name !== CREATE_PLAN && name !== REPORT_PLAN));
		state = next === "implementing" ? { phase: next, failedTurns: 0 } : { phase: next };
	}

	/** The run settled or a new prompt came before a plan: the saved tools come back as they were (R15). */
	function abandonPlanning(): void {
		if (state.phase !== "planning") return;
		setActiveToolsIfChanged(state.toolsBefore);
		state = { phase: "used" };
	}

	const createPlanTool = defineTool({
		name: CREATE_PLAN,
		label: "Start planning",
		description: CREATE_PLAN_DESCRIPTION,
		parameters: Type.Object({}),
		defaultActive: false,
		renderShell: "self",
		renderCall: (_args, theme) => row(theme.fg("muted", PLANNING_LABEL)),
		renderResult: (result, { expanded }, theme, context) =>
			renderPlanningResult(resultText(result), expanded, context.isError, theme),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!isEcoModel(ctx.model)) throw new Error(ECO_MODEL_REQUIRED_ERROR);
			// handleMessageEnd started planning for the first create_plan call of the task; any other call is a repeat.
			if (state.phase !== "planning" || state.callId !== toolCallId) throw new Error(PLAN_ALREADY_USED_ERROR);
			// handleSessionStart restores these tools if the session stops before a plan is accepted.
			const details: CreatePlanDetails = { activeTools: state.toolsBefore };
			return { content: [{ type: "text", text: PLANNING_INSTRUCTIONS }], details };
		},
	});

	const reportPlanTool = defineTool({
		name: REPORT_PLAN,
		label: "Report plan",
		description: REPORT_PLAN_DESCRIPTION,
		parameters: Type.Object({
			plan: Type.String({ description: PLAN_PARAMETER_DESCRIPTION }),
			summary: Type.String({ description: SUMMARY_PARAMETER_DESCRIPTION }),
		}),
		defaultActive: false,
		renderShell: "self",
		renderCall: (args, theme, context) => {
			const summary = context.argsComplete ? reportedSummary(args) : "";
			return row(summary ? `${theme.fg("success", "●")} ${summary}` : theme.fg("muted", WRITING_PLAN_LABEL));
		},
		renderResult: (result, { expanded }, theme, context) => {
			const plan = typeof context.args?.plan === "string" ? context.args.plan.trim() : "";
			return renderPlanningResult(context.isError ? resultText(result) : plan, expanded, context.isError, theme);
		},
		async execute(_toolCallId, { plan, summary }) {
			if (state.phase !== "planning") throw new Error(NO_ACTIVE_PLANNING_ERROR);
			const normalized = plan.trim();
			if (!normalized) throw new Error(EMPTY_PLAN_ERROR);
			finishPlanning("implementing");
			return {
				content: [{ type: "text", text: `${normalized}\n\n${IMPLEMENT_FROM_PLAN}` }],
				details: { summary: reportedSummary({ plan: normalized, summary }) },
			};
		},
	});

	return {
		createPlanTool,
		reportPlanTool,

		/**
		 * Whether the router sends the task's next request to the implementation model: the task implements an accepted
		 * plan (R11), as with Junie's useImplementModel (agent/modelmix/ModelMixContext.kt:45), and the implementation
		 * model has not just failed MAX_FAILED_TURNS turns in a row (R14).
		 */
		useImplementationModel: () => state.phase === "implementing" && state.failedTurns < MAX_FAILED_TURNS,

		/** A new session starts without planning; one saved mid-planning gets its original tools back (R15). */
		handleSessionStart(_event: SessionStartEvent, ctx: ExtensionContext) {
			state = { phase: "idle" };
			const tools = toolsBeforeUnfinishedPlanning(ctx.sessionManager.buildSessionProjection().messages);
			if (tools) setActiveToolsIfChanged(tools);
		},

		/**
		 * A new task may plan again. On an Eco pair with both planning tools registered, create_plan is offered, and the
		 * model_mix section says when to call it or that it is unavailable (R4, R21); other models get neither tool.
		 */
		handleBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
			abandonPlanning();
			state = { phase: "idle" };
			const eco = isEcoModel(ctx.model);
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const canPlan = eco && registered.has(CREATE_PLAN) && registered.has(REPORT_PLAN);
			const tools = pi.getActiveTools().filter((name) => name !== REPORT_PLAN && (canPlan || name !== CREATE_PLAN));
			if (canPlan && !tools.includes(CREATE_PLAN)) tools.push(CREATE_PLAN);
			setActiveToolsIfChanged(tools);
			if (!eco) return;
			const planOffered = canPlan && pi.getActiveTools().includes(CREATE_PLAN);
			// A section, not a returned systemPrompt: a forced prompt would drop the guidelines and sections that
			// handlers registered after this one add.
			event.systemPromptOptions.sections.model_mix = planOffered ? MODEL_MIX_GUIDANCE : MODEL_MIX_NO_PLAN_GUIDANCE;
		},

		/**
		 * The first create_plan call of a task on an Eco pair starts planning once its message ends (R5). A message the
		 * user writes after the plan, such as steering, returns the rest of the task to the primary model (R3).
		 */
		handleMessageEnd({ message }: MessageEndEvent, ctx: ExtensionContext) {
			if (message.role === "user" && state.phase === "implementing") state = { phase: "used" };
			if (state.phase !== "idle" || message.role !== "assistant" || !isEcoModel(ctx.model)) return;
			const calls = message.content.filter((block) => block.type === "toolCall");
			const call = calls.find((block) => block.name === CREATE_PLAN);
			if (call) startPlanning(call.id);
		},

		/** Read-only guard during planning (R6): no edit, and write only to paths that do not exist yet. */
		handleToolCall(event: ToolCallEvent, ctx: ExtensionContext) {
			if (state.phase !== "planning") return;
			if (event.toolName === "edit") return { block: true, reason: READ_ONLY_ERROR };
			if (!isToolCallEventType("write", event)) return;
			const { path } = event.input;
			if (!path || existsSync(resolve(ctx.cwd, path))) return { block: true, reason: READ_ONLY_ERROR };
		},

		/** Junie's out-of-turns warning on exploration results of the last planner turns (R7). */
		handleToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
			if (state.phase !== "planning" || state.turns < WARN_AFTER_TURNS || event.toolName === REPORT_PLAN) return;
			return {
				content: [...event.content, { type: "text", text: OUT_OF_TURNS_WARNING }],
				structuredContent: event.structuredContent,
			};
		},

		/**
		 * Counts completed turns. While the task plans, planner turns (R7): the last request offers only report_plan, and
		 * when the limit is reached without a plan, the task goes on without one (R15). After the plan, failed turns of
		 * the implementation model in a row (R14).
		 */
		handleTurnEnd(event: TurnEndEvent) {
			// A provider error emits turn_end too. Pi drops the failed response from the context and repeats the request
			// on the same model (R13) or ends the run, so it is neither a planner turn nor a failed turn.
			if (event.outcome !== "completed") return;
			if (state.phase === "implementing") {
				// The turn after MAX_FAILED_TURNS failures went to the primary model; the implementation model starts over.
				state.failedTurns = state.failedTurns < MAX_FAILED_TURNS && turnFailed(event) ? state.failedTurns + 1 : 0;
				return;
			}
			if (state.phase !== "planning") return;
			// The parent's create_plan call is not a step of Junie's child planner.
			if (event.toolResults.some((result) => result.toolName === CREATE_PLAN)) return;
			state.turns++;
			if (state.turns === FORCE_REPORT_AFTER_TURNS) setActiveToolsIfChanged([REPORT_PLAN]);
			if (state.turns < MAX_PLANNER_TURNS) return;
			finishPlanning("used");
			return { entries: [...event.entries, PLAN_EXHAUSTED_MARKER], continue: true };
		},

		/** The last planner request requires report_plan where the provider supports named tool choice (R7). */
		handleBeforeProviderRequest(event: BeforeProviderRequestEvent) {
			if (state.phase !== "planning" || state.turns !== FORCE_REPORT_AFTER_TURNS) return;
			return forceReportPlan(event.payload);
		},

		/** Planning that has not reported a plan ends with the run (R15, R20). */
		handleAgentSettled() {
			abandonPlanning();
		},

		/** Folds every finished planning into its create_plan result (R12, R15). */
		handleContext(event: ContextEvent) {
			const messages = foldPlanning(event.messages);
			return messages ? { messages } : undefined;
		},
	};
}
