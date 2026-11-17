// The todo list of the @juicesharp/rpiv-todo plugin as the session's plan. The plugin's `todo` tool returns the
// whole list after every call (`details.tasks`); the bridge shows that list as the client's plan instead of the
// tool's rows.

import type { PlanEntry, PlanUpdate } from "../core/types.ts";

/** The plugin's tool (its replay key; the plugin pins this name). */
export const TODO_TOOL = "todo";
/** Plan id of the todo list (Junie's delivery plan id). */
export const TODO_PLAN_ID = "main";

interface Task {
	subject?: unknown;
	activeForm?: unknown;
	status?: unknown;
}

/** The plan for a `todo` result's details; undefined when the details are not the plugin's task list. */
export function todoPlan(details: unknown): PlanUpdate | undefined {
	const tasks = (details as { tasks?: unknown } | undefined)?.tasks;
	if (!Array.isArray(tasks)) return undefined;
	const entries: PlanEntry[] = [];
	for (const task of tasks as Task[]) {
		if (!task || typeof task.subject !== "string" || !task.subject.trim()) continue;
		const status = task.status === "completed" || task.status === "in_progress" ? task.status : task.status === "pending" ? "pending" : undefined;
		if (!status) continue; // deleted
		entries.push({ content: task.subject.trim(), status, priority: "medium" });
	}
	return entries.length ? { kind: "items", id: TODO_PLAN_ID, entries } : { kind: "removed", id: TODO_PLAN_ID };
}
