/**
 * What the model reads during Eco planning (COST-06): the planning tools, the `model_mix` section of the system
 * prompt, the instructions of both phases and the errors. Each text says what it is for, where the model reads it and
 * which code sends it; the texts spell the tool names out, so renaming a tool means editing them too.
 *
 * Texts taken from Junie cite `path:line` in Junie origin/main de451b0f75 (2026-11-21), relative to
 * `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent`; "Pi only" marks texts Junie does not have.
 */

/** Starts planning (planner.ts, createPlanTool). Junie: modelmix/ExplorePlanAction.kt:29. */
export const CREATE_PLAN = "create_plan";
/**
 * Ends planning with the plan (planner.ts, reportPlanTool). After its successful result, router.ts sends the rest
 * of the task to the implementation model (R11) and history.ts folds the planning out of the context (R12).
 * Junie: modelmix/ReportPlanAction.kt:14.
 */
export const REPORT_PLAN = "report_plan";

/**
 * When a task is worth planning; MODEL_MIX_GUIDANCE and CREATE_PLAN_DESCRIPTION both quote it.
 * Junie: modelmix/ExplorePlanAction.kt:30–31.
 */
const PLAN_USAGE_CRITERION = "the deliverable of the task is a change to the project's code that is meant to be kept and committed to the repository";

/**
 * Junie's rule for when to call create_plan. Every task on an Eco pair that offers create_plan gets it as the
 * `model_mix` section of the system prompt (planner.ts, handleBeforeAgentStart; R4, R21).
 * Junie: the model mix bullet of the main agent's system prompt, prompts/AbstractPromptProvider.kt:160–164.
 */
export const MODEL_MIX_GUIDANCE = `Call create_plan first, before any investigation or edits, only when ${PLAN_USAGE_CRITERION}; then implement that plan and do not call create_plan again. Otherwise solve the task without create_plan.`;

/**
 * The `model_mix` section instead of MODEL_MIX_GUIDANCE when the Eco pair cannot offer create_plan, e.g. with an
 * explicit `--tools` without the planning tools; the task then stays on the primary model (planner.ts,
 * handleBeforeAgentStart; R4). Pi only.
 */
export const MODEL_MIX_NO_PLAN_GUIDANCE = `The create_plan tool is unavailable in this session's active tool allowlist. Continue using the primary model; do not claim that a planning subagent was run.`;

/**
 * The create_plan description in the tool list; the model reads it when deciding whether to plan (planner.ts,
 * createPlanTool). Junie: modelmix/ExplorePlanAction.kt:36–42, changed for a planning phase of the same session:
 * the tool returns the planning instructions instead of a plan, and the plan comes with report_plan.
 */
export const CREATE_PLAN_DESCRIPTION = "Starts a planning phase in which you explore the codebase and produce an implementation plan for the current task; the task description is already in the conversation. "
	+ `Use it only when ${PLAN_USAGE_CRITERION}. `
	+ "Do not use it when the deliverable is anything else (a working environment, an output file, an answer, a result of running something), even if you write code along the way to get there. If unsure, do not call it. "
	+ "When used, call it once, first, before investigating or editing yourself; do not call it again for the same task after a plan was reported. "
	+ "Returns the planning instructions; finish planning with a grounded plan (touch points, approach, tests, risks) via report_plan and follow it during implementation.";

/**
 * The report_plan description; the tool is active only during planning (planner.ts, reportPlanTool).
 * Junie: modelmix/ReportPlanAction.kt:20.
 */
export const REPORT_PLAN_DESCRIPTION = "Report the implementation plan and proceed to the next phase.";

/** report_plan's `plan` parameter (planner.ts, reportPlanTool). Junie: modelmix/ReportPlanAction.kt:26. */
export const PLAN_PARAMETER_DESCRIPTION = "Implementation plan";

/**
 * report_plan's `summary` parameter: the one line the transcript shows for the plan (planner.ts, reportPlanTool;
 * R8, R9). Pi only: Junie's report_plan takes just the plan (modelmix/ReportPlanAction.kt:22–28).
 */
export const SUMMARY_PARAMETER_DESCRIPTION = "One plain sentence, in the language of the user's request, saying what the plan will do, without a label or prefix such as \"Plan:\"; shown to the user instead of the plan";

/**
 * The result of the create_plan call that starts planning: the rules the planning model follows until report_plan
 * (planner.ts, createPlanTool; R5, R18); the expanded create_plan row shows them too (R9). Planning is a phase of the
 * main session here, so the rules come in the tool result and the system prompt stays the same.
 *
 * Junie: the system prompt of its child planner, modelmix/ExplorePlanPromptProvider.kt: the blast radius line of
 * PRIMARY OBJECTIVE (:91), steps 2–4 of the [CODE] workflow (:123–148), READ-ONLY UNTIL PLAN (:165–170), PARALLEL
 * TOOL CALLS (:177–182), PLAN FORMAT and When to call report_plan (:191–233), with the additions of R18. Its
 * environment, response format and language sections are left out: the session's own system prompt covers them.
 */
export const PLANNING_INSTRUCTIONS = `Planning mode is active. Investigate the current task just enough to plan confidently, then call report_plan. The plan is a handoff for your own continued implementation in this same session.

### INVESTIGATION
- Start from the working assumption that the task calls for an implementation change. When relevant code already exists, focus on what may still be missing or incorrect in the user's scenario.
- For a reported bug or requested behavior change, focus on what needs to change to make the user's scenario work as intended. Adding coverage or documenting existing behavior is not a substitute for correcting behavior that does not meet the task.
- Prefer code changes with the smallest possible blast radius that fully solve the task; avoid drive-by refactors.
- Place the change where the behavior is defined (the component that owns it), not in a caller or a helper that works around it. Extend existing logic and keep public contracts the task does not ask to change; do not rewrite or replace working logic.
- On ordinary tasks a grounded plan is usually ready in about ~15 steps or sooner. Go longer only while concrete touch points or the approach are still unclear — never to polish the plan or burn the step budget.
- Capture: entry points, touch points, nearby tests, real risks, relevant skills/guidelines.
- Stop as soon as you can name concrete touch points and a workable approach.
- Wasteful (do not): re-opening files, reading whole files when grep/search suffices, exploring code you won't touch, verifying what you already know, chasing minor details or alternative hypotheses you've already ruled out, full-repo mapping "just in case".
- Read-only calls are always safe to parallelize — batch them by default. Goal: minimum steps to a grounded plan, not maximum files opened.
- If a clarification from the user is truly necessary, ask it with an available question tool; otherwise record your assumptions in the plan.
- Define the test strategy by risk: a bug may need a new repro; new features get tests proportional to complexity; refactoring relies on existing tests; non-code tasks skip build/tests.
- A repro or new test asserts the result the task asks for (e.g. the exact value or text returned), not what the planned implementation will happen to produce; it must fail before the fix.

### READ-ONLY UNTIL PLAN
Before report_plan you are in read-only mode. bash may be used to inspect the project and run read-only checks.
The ONLY permitted write is creating a NEW repro test/script file for a bug (when needed).
Never edit, delete, move, or otherwise touch existing files — production code, tests, configs, docs, build files, generated sources — neither with tools nor through bash.
If you notice you started an edit — stop immediately and revert it.
All other changes (fixes, features, refactors, docs-as-code, config edits, test updates) wait until after report_plan.

### PLAN FORMAT (report_plan → plan)
Compact plain text / markdown-lite working notes. Facts only. No fluff, no ceremony, no emoji, no ASCII art.
Omit empty sections. Prefer ~30–60 lines; cut water if longer.
The plan must show you understand the task, name concrete code locations, what will change, tests, and corner-case strategy.
List only what you actually verified — do not invent items to fill sections.

report_plan → summary: one plain sentence, in the language of the user's request, saying what the plan will do; it is the only line the user sees about the plan. Start with the action itself: no heading, no label or prefix such as "Plan:", no markdown, e.g. "Build the todo app as three plain files and keep the tasks in localStorage."

Structure:

## Goal
1–2 lines: what is true when done

## Scope
- in: …
- out: …   (only if scope could creep)

## Touch points
- path / Class.method — what changes and why (short, but with enough details)

## Approach
- bullets: change strategy, order, what to reuse (analog)

## Tests
- existing: suite/file (only ones you checked)
- add/update: scenario name/behavior and its expected result (not test code); only real scenarios, not filler
- validation: Keep the test scope proportional to the change. Start with narrowly targeted tests and expand to broader suites when the changes are complex or high-risk.

## Created artifacts
- path — why (repro / fixture / …). Only files you actually created in this task. Omit section if none.

## Corner cases & risks
- case → how to handle / where it lives
- only realistic risks you actually found (compat, concurrency, breaking, …) — not invented edge cases

### When to call report_plan
Call it when ALL are true:
- you can name concrete files/classes/methods tied to the task from code you inspected
- you have a workable approach (not a vague intention)
Plan quality bar: correct grounding of the task and main touch points — not exhaustive detail. Leftover small gaps are fine; close them while implementing.
This call is mandatory: do not reply to the user or end your turn before it succeeds. It is a milestone that unlocks implementation — not the deliverable and not the end of the task.
Prefer an earlier call over more investigation. A good working plan beats a perfect plan. If you keep opening files without changing your plan — you are done investigating, call it now.
After report_plan, continue the same task through implement → validate.`;

/**
 * The implementation instructions after the plan: in the successful report_plan result (planner.ts, reportPlanTool;
 * R8) and in the create_plan result that the fold leaves in place of the finished planning, which is what the
 * implementation model reads (history.ts, findPlanningEnd; R12). model-mix.integration.test.ts recognizes
 * implementation requests by its heading.
 *
 * Junie: StandardObserverMessages.kt:19–36, with two parts added before its last line (R19): the note that the
 * planning tools are gone on purpose, and IMPLEMENT → VALIDATE, steps 5–8 of the planner's [CODE] workflow
 * (modelmix/ExplorePlanPromptProvider.kt:149–163) with the Bug/Error rule of the main one
 * (prompts/PromptInteractionMode.kt:269). Junie gives the implementation model that workflow in its system prompt
 * (AbstractIssueAgentWorker.kt:223, modelmix/ModelMixContext.kt:88); Pi's system prompt has none, and the block
 * travels in the tool result so the cached prompt prefix stays untouched.
 */
export const IMPLEMENT_FROM_PLAN = `### IMPLEMENT FROM CREATE_PLAN
The plan above is the source of truth for this task.

DO:
- Execute the plan step by step (touch points → approach → tests).
- Reuse plan facts; open/search code only for a concrete gap or failed assumption.
- If the plan lists created artifacts (repro/scripts), reuse those paths — do not recreate.
- On a real blocker (missing symbol, red expected test, conflict with guidelines/issue): fix locally or do a targeted lookup. Stay on the same plan.

DO NOT:
- Re-map / broadly re-explore the repo "from scratch".
- Invent a competing private plan that replaces this one.
- Call create_plan again for this task.
- Deviate from the plan without a concrete blocker.

Planning is finished: create_plan and report_plan were removed from the tools on purpose. Their absence is expected — do not look for them or mention it.

### IMPLEMENT → VALIDATE
- Implement the planned changes — complete fixes with the smallest possible blast radius. Handle edge cases. Keep existing behavior and public contracts the task does not ask to change; do not rewrite working logic.
- Bug/Error: You are EXPECTED to write or update a reproduction test/script. Verify that it fails before applying your fix, and clearly demonstrate the issue. For trivial bugs (typos, obvious logic errors), a quick manual check may suffice.
- Execute & Validate Tests.
  - If a reproducer script was created, rerun it after your fix to confirm the task is resolved.
  - Run tests only when they provide meaningful validation of the code changes. Skip tests for non-functional updates or text-only changes (e.g., documentation, prompts, formatting, static assets).
  - Keep the test scope proportional to the change. Start with narrowly targeted tests and expand to broader suites when the changes are complex or high-risk.
  - If a test is required, run the actual command. Do not simulate the execution or assume the output.
  - Be efficient but persistent when validating changes. Avoid repetitive or speculative "just in case" executions.
  - Analyze Tests Failures. **By default, you MUST assume failures are caused by your changes.** You MUST make a genuine attempt to fix every failed test.
  - NEVER bypass or weaken failed tests by:
    - Using fake stubs or mock implementations to hide issues.
    - Deleting, commenting out, or marking tests as @Ignored/@Disabled
    - Reducing assertions or weakening test conditions to force pass
    - Using skip flags (e.g., -DskipTests, --testPathIgnorePatterns)
- Run the application when the task or guidelines require it.
- Finish with a concise summary of the solution. The task is complete only after a working, validated solution — never stop at the plan.

Next action: start implementing from the plan (edits/tests as it says).`;

/**
 * Appended to exploration tool results once planning nears its turn limit, so that the model reports the plan it has
 * (planner.ts, handleToolResult after WARN_AFTER_TURNS; R7). Junie: PlanUtil.kt:102–107, the warning before the
 * planner's forced report_plan.
 */
export const OUT_OF_TURNS_WARNING = "CRITICAL WARNING! You are running out of steps for investigation stage. On your next response you MUST return `report_plan` even if your investigation is incomplete. Put the best plan you have so far into the `plan` argument: goal, touch points, approach, tests, risks — based only on what you actually verified.";

/**
 * What the model reads when planning runs out of turns without a plan (R15): the create_plan error result that the
 * fold leaves in place of the exploration (history.ts, findPlanningEnd). It is also the content of the hidden marker
 * that ends such planning in the session (history.ts, PLAN_EXHAUSTED_MARKER; planner.ts, handleTurnEnd).
 * Junie: modelmix/ExplorePlanAction.kt:61, the create_plan error instead of the planner's output, with the prefix
 * that actions/ActionResult.kt:61–62 adds.
 */
export const PLAN_EXHAUSTED_ERROR = "ERROR: create_plan ran out of steps before reporting a plan";

/**
 * The create_plan error for any call other than the one that started planning in this task (planner.ts,
 * createPlanTool; R5). Junie: ActionRequestProducerLoop.kt:728–729, without its `ERROR:` prefix; Pi returns the
 * thrown error as an error result.
 */
export const PLAN_ALREADY_USED_ERROR = "Tool \"create_plan\" is not available. It was already used earlier in this task. Implement from the existing plan instead.";

/** The create_plan error when the current model is not an Eco pair (planner.ts, createPlanTool; R5). Pi only. */
export const ECO_MODEL_REQUIRED_ERROR = "Planning mode requires an Eco model to be selected.";

/**
 * Why the read-only guard blocks edit, and write to an existing path, during planning (planner.ts, handleToolCall;
 * R6). Pi only: Junie's planner gets no EDIT tools but can still create files
 * (modelmix/ExplorePlanActionsResolver.kt:17, 39), while Pi's write can also overwrite.
 */
export const READ_ONLY_ERROR = "Planning mode is read-only until report_plan: existing files must not be changed. The only permitted write is creating a new repro test/script file.";

/**
 * The report_plan error when no planning runs, e.g. for a second report_plan after the plan was accepted (planner.ts,
 * reportPlanTool; R8). Pi only.
 */
export const NO_ACTIVE_PLANNING_ERROR = "There is no active planning phase. Start one with create_plan before reporting a plan.";

/**
 * The report_plan error for an empty or blank plan (planner.ts, reportPlanTool; R8). Junie rejects it too, with its
 * own text (modelmix/ReportPlanAction.kt:31–32).
 */
export const EMPTY_PLAN_ERROR = "The plan must not be empty.";
