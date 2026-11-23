import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { appendBenchmarkRules } from "./benchmark-rules.ts";
import { createCompactionHandler } from "./compaction-summary.ts";
import { createUnlimitedHistoryProcessor } from "./history-processor.ts";
import { createModelMixPlanner } from "./model-mix/planner.ts";
import { ecoModels } from "./model-mix/router.ts";
import { selectSummarizationModel } from "./summarization-client.ts";
import { createTaskJournal } from "./task-journal.ts";
import { createToolOutputProcessor, limitToolInput } from "./tool-output-processor.ts";

export { createSummarizationClient, selectSummarizationModel } from "./summarization-client.ts";
export type { SummarizationOptions } from "./summarization-client.ts";

const BASH_TIMEOUT_GUIDELINE = [
	"For `bash`, choose `timeout` greedily based on realistic estimates — do not use the maximum timeout as a default.",
	"Overestimating wastes session time needed for other commands.",
	"For orientation, Junie uses 60 seconds by default, 300 seconds for long-running commands, and a 20–3600 second range.",
	"These are reference values, not Pi defaults or enforced limits.",
	"`timeout` is in seconds, not milliseconds: 300 means five minutes.",
].join(" ");
// Junie's largest bash timeout; a larger value is taken for milliseconds, which models often pass.
const MAX_TIMEOUT_SECONDS = 3600;

function bashTimeoutInSeconds(event: ToolCallEvent): void {
	if (!isToolCallEventType("bash", event)) return;
	const { timeout } = event.input;
	if (typeof timeout === "number" && timeout > MAX_TIMEOUT_SECONDS) event.input.timeout = Math.ceil(timeout / 1000);
}

export default function junieCost(pi: ExtensionAPI): void {
	// 0. Eco mode (Model Mix): the primary model of an Eco pair plans, a cheap model implements (COST-06).
	// Planning is a read-only phase of the main session from create_plan to report_plan.
	const planner = createModelMixPlanner(pi);
	// Virtual `<id>-eco` models keep the user-selected model and ctx.model stable while each physical request is routed
	// by its conversation: the cheap model takes the task only after an accepted plan, and after three failed turns
	// in a row one request goes back to the primary model.
	// pi-junie change: only when the JetBrains AI provider is loaded (its physical models are there at session start).
	// Without it the `-eco` models alone made Pi list a placeholder "jetbrains-ai ✓ virtual" provider that cannot log in.
	let ecoRegistered = false;
	pi.on("session_start", (_event, ctx) => {
		if (ecoRegistered) return;
		if (!ctx.modelRegistry.getAll().some((m) => m.provider === "jetbrains-ai" && !m.id.endsWith("-eco"))) return;
		for (const model of ecoModels()) pi.registerVirtualModel(model);
		ecoRegistered = true;
	});
	pi.registerTool(planner.createPlanTool);
	pi.registerTool(planner.reportPlanTool);
	// A new or resumed session starts without planning. Pi restores the tool set from the transcript,
	// so a session saved mid-planning would resume without edit: it gets its original tools back.
	pi.on("session_start", planner.handleSessionStart);
	// Every task may plan once: offer create_plan on Eco pairs and tell the model when to call it.
	pi.on("before_agent_start", planner.handleBeforeAgentStart);
	// Start planning when the message with create_plan ends: Pi awaits this before it runs the message's calls,
	// so the other calls of that message already meet the read-only guard. A user message after the plan
	// (steering, a follow-up) ends before the next request is routed and returns the task to the primary model.
	pi.on("message_end", planner.handleMessageEnd);
	// Read-only guard during planning: no edit, write only to new paths.
	pi.on("tool_call", planner.handleToolCall);
	// Junie's out-of-turns warning on exploration results near the planner's turn limit.
	pi.on("tool_result", planner.handleToolResult);
	// Before the next request is routed, count completed turns: planner turns (the last request offers only
	// report_plan, then planning gives up) and, after the plan, failed turns of the implementation model.
	pi.on("turn_end", planner.handleTurnEnd);
	// The last planner request requires report_plan through the provider's tool choice where it is supported.
	pi.on("before_provider_request", planner.handleBeforeProviderRequest);
	// Restore the tools of a planning that never reported. Not agent_end: Pi emits it after every failed attempt
	// and retries the turn in the same run, which would leave the retried planner without report_plan.
	pi.on("agent_settled", planner.handleAgentSettled);
	// Before each request, fold finished planning into the create_plan result: the implementation model gets only
	// the plan, and the session file keeps the whole exploration.
	pi.on("context", planner.handleContext);

	// 1. Tool output limits and summaries.
	// Keeps every tool result small before it enters the context, as Junie's OutputHelper and bash summaries do.
	// The one-line summaries it caches by toolCallId are shared with the history processor and the journal below.
	const outputProcessor = createToolOutputProcessor();
	// Before a call runs: give `read` a default 100/300-line window when the model did not choose a `limit`.
	pi.on("tool_call", limitToolInput);
	// After a call runs: truncate long output, summarize large bash output with the cheap model,
	// save the full output to a log next to the session file (or a temp dir without a session)
	// and start background summaries for later history thinning.
	pi.on("tool_result", outputProcessor.handleResult);
	// When a run ends or Pi exits: cancel pending summaries and delete the temp-dir logs of an in-memory session.
	pi.on("agent_settled", () => outputProcessor.cleanup());
	pi.on("session_shutdown", () => outputProcessor.cleanup());

	// 2. Cache-aware history thinning (plan item 3).
	// Replaces old tool results with summaries or placeholders via persistent context edits,
	// but only when the saving outweighs re-caching the prompt, as Junie's UnlimitedStepsHistoryProcessor does.
	const historyProcessor = createUnlimitedHistoryProcessor(outputProcessor.summaries);
	// A new or resumed session starts without a known prompt-cache age.
	pi.on("session_start", historyProcessor.reset);
	// Each assistant response refreshes the provider's prompt cache; remember when, to estimate whether it is still warm.
	pi.on("message_end", historyProcessor.handleMessageEnd);
	// Between turns the next request has not been sent yet: the cheapest moment to decide on and apply the edits.
	pi.on("turn_end", historyProcessor.handleTurnEnd);

	// 3. Task journal (plan item 4).
	// Stores structured facts about every finished task in the session file, invisible to the model,
	// so that the compaction summary can be built by code instead of the main model.
	const journal = createTaskJournal(outputProcessor.summaries);
	// File snapshots and pending calls belong to one session; drop them when another one starts.
	pi.on("session_start", journal.reset);
	// Before a call runs: snapshot a file before its first edit/write in the task (for the patch)
	// and mark the call as not executed yet (for rejection detection).
	pi.on("tool_call", journal.handleToolCall);
	// The call did run, so it was not rejected.
	pi.on("tool_result", journal.handleToolResult);
	// A task completed: append one `task-journal` record with requests, answer, patch, reads, commands and rejections.
	pi.on("agent_before_settle", journal.handleBeforeSettle);

	// 4. Compaction summary from the journal (plan item 4).
	// Between tasks, replaces Pi's main-model summary with one rendered from the journal, as Junie's
	// CompressHistoryProcessor does; mid-task, on retry or on any error, Pi's default compaction runs instead.
	// `journal.collect` builds an in-memory record for the task that has just ended but is not journaled yet.
	pi.on("session_before_compact", createCompactionHandler(journal.collect));

	// 5. Benchmark rules for eval runs.
	// Appends JUNIE_BENCHMARK_RULES after the task text of a new prompt, as Junie does after the issue description.
	pi.on("input", appendBenchmarkRules);

	// 6. Bash timeout guidance.
	// Adds Junie's instruction and reference values to the structured prompt.
	pi.on("before_agent_start", (event) => {
		const { selectedTools, hiddenTools, promptGuidelines } = event.systemPromptOptions;
		if (selectedTools.includes("bash") && !hiddenTools.includes("bash") && !promptGuidelines.includes(BASH_TIMEOUT_GUIDELINE)) {
			promptGuidelines.push(BASH_TIMEOUT_GUIDELINE);
		}
	});
	// Before a call runs: models trained on agents with millisecond timeouts pass e.g. 120000, which Pi takes
	// for 33 hours; a timeout above one hour is converted from milliseconds to seconds.
	pi.on("tool_call", bashTimeoutInSeconds);

	// Diagnostics: show which cheap model the summaries above would use, without calling it.
	pi.registerCommand("junie-cost", {
		description: "Show the summarization model used by Junie cost optimizations (no LLM call)",
		handler: async (_args, ctx) => {
			const model = selectSummarizationModel(ctx);
			ctx.ui.notify(
				model ? `Summarization model: ${model.provider}/${model.id}` : "No model selected.",
				model ? "info" : "warning",
			);
		},
	});
}