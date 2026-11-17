// Plan mode from the @narumitw/pi-plan-mode plugin, driven by the bridge.
//
// The plugin owns the mode: in plan mode it restricts the agent to read-only tools and has it finish with a plan
// (its `plan_mode_complete` tool, or a <proposed_plan> block), then waits for a decision. Its own decision menu
// needs Pi's terminal UI, which bridge sessions have not, so the bridge reads the plugin's saved state after each
// run and asks the user through the client instead, then answers with the plugin's commands:
// `/plan start`, `/plan implement`, `/plan exit`.

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_PLUGIN = "@narumitw/pi-plan-mode";
/** The plugin's tools; it refuses to start plan mode unless both are active. */
export const PLAN_MODE_TOOLS = ["plan_mode_complete", "plan_mode_question"];
/** The tool the agent hands the finished plan to (shown as the plan itself, not as a tool row). */
export const PLAN_COMPLETE_TOOL = "plan_mode_complete";
/** Plan id of the reviewed Markdown plan. */
export const REVIEW_PLAN_ID = "plan";

/** The plugin's session entry (custom entry `plan-mode-state`, the plugin's persisted `PlanModeState`). */
const STATE_ENTRY = "plan-mode-state";

export interface PluginPlanState {
	enabled: boolean;
	/** The finished plan, while it waits for a decision. */
	awaitingPlan?: string;
}

/** The plugin's state as it last saved it on the session's branch (off when it never saved one). */
export function readPlanModeState(session: Pick<AgentSession, "sessionManager">): PluginPlanState {
	const branch = session.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const data = (entry.data ?? {}) as { enabled?: unknown; awaitingAction?: unknown; latestPlan?: unknown };
		const enabled = data.enabled === true;
		const plan = typeof data.latestPlan === "string" && data.latestPlan.trim() ? data.latestPlan.trim() : undefined;
		return { enabled, ...(enabled && data.awaitingAction === true && plan ? { awaitingPlan: plan } : {}) };
	}
	return { enabled: false };
}

/**
 * Runs one of the plugin's `/plan` commands and waits for the agent run it starts, if any. The plugin starts runs
 * with `sendUserMessage`, which Pi does not await, so the command returns before its run begins.
 */
export async function runPlanCommand(pi: AgentSession, command: string, startWithinMs = 2000): Promise<void> {
	let started = false;
	let onStart = () => {};
	const unsubscribe = pi.subscribe((event) => {
		if (event.type === "agent_start") {
			started = true;
			onStart();
		}
	});
	try {
		await pi.prompt(command);
		if (!started) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, startWithinMs);
				onStart = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
		if (started) await pi.waitForIdle();
	} finally {
		unsubscribe();
	}
}
