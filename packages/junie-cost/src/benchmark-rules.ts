import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

/** Set by eval pipelines, as for Junie (`EjProperties.BENCHMARK_RULES`); unset or blank means not a benchmark run. */
export const BENCHMARK_RULES_ENV = "JUNIE_BENCHMARK_RULES";

/**
 * Appends the benchmark rules after the task text of every new user prompt, as Junie's
 * `AbstractPromptProvider.getIssueDescriptionAndInstructions` puts them right after the issue description.
 * The rules travel in the user message, so the system prompt and its cache stay untouched.
 */
export function appendBenchmarkRules(event: InputEvent): InputEventResult {
	const rules = process.env[BENCHMARK_RULES_ENV]?.trim();
	if (!rules) return { action: "continue" };
	// Steering and follow-up messages continue the running task; messages of other extensions are theirs.
	if (event.streamingBehavior || event.source === "extension") return { action: "continue" };
	// Commands, skills and prompt templates are expanded later; extra text would become their arguments.
	if (event.text.trimStart().startsWith("/")) return { action: "continue" };
	// A runner may already have added the rules to the task text itself.
	if (event.text.includes(rules)) return { action: "continue" };
	return { action: "transform", text: `${event.text.trimEnd()}\n\n${rules}` };
}
