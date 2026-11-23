---
id: COST-06
title: Eco mode (Model Mix)
package: junie-cost
status: implemented
pi: 1.5.2
depends: [AI-01, AI-02]
code: [packages/junie-cost/src/model-mix/router.ts, packages/junie-cost/src/model-mix/planner.ts, packages/junie-cost/src/model-mix/history.ts, packages/junie-cost/src/model-mix/prompts.ts, packages/junie-cost/src/utils.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/model-mix.integration.test.ts, packages/junie-cost/test/bash-guidance.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-model-mix.md, packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R1, R2, R9, R10, R13, R14, R17]
---

# COST-06. Eco mode (Model Mix)

## Goal

The user selects an Eco pair, for example `jetbrains-ai/claude-opus-5-5-eco`, and gets Model Mix as in Junie: a strong model explores the task and writes a plan, and a cheap one implements it in the same session. In the transcript, the plan is shown as a single row. How this works in Junie is described in [junie-model-mix.md](../../research/junie-model-mix.md).

## Behavior

Models:

- **R1.** Virtual models `jetbrains-ai/<id>-eco` named `<id> (Eco)` are registered for `claude-fable-5-1`, `claude-fable-5-2`, `claude-opus-5`, `claude-opus-5-5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `grok-4.6`, and `grok-4.7`. Reasoning levels are `low`/`medium`/`high`; `claude-opus-5-5` and `gpt-6.1-terra` have no `low`.
- **R2.** If the pair's main model is not among the available `jetbrains-ai` models, the request fails with the error `Eco mode requires jetbrains-ai/<id> with valid credentials`.
- **R3.** A task, i.e. a run started by a prompt or an extension message, goes to the pair's main model with the selected reasoning level until a plan is accepted (R11). A message the user writes during the run after the plan (steering, a follow-up) returns the rest of the task to the main model, and the task does not plan again, as a realtime follow-up resumes a task in Junie without its model mix context ([research](../../research/junie-model-mix.md#between-tasks)).

Tools and prompt:

- **R4.** With an Eco pair selected, `create_plan` is activated in `before_agent_start`, and Junie's rule is added to the system prompt as the `model_mix` section (R21): call `create_plan` first and only if the task's result is a code change to commit. If `create_plan` and `report_plan` are unavailable (an explicit `--tools` without them), only an instruction to work on the main model is added. For a regular model, both tools are deactivated, even if they are in the allowlist, and the rule is not added.
- **R5.** `create_plan` without parameters starts planning only on the first call in a task on an Eco pair: it saves the active tools, deactivates `edit`, activates `report_plan`, and returns Junie's planning instructions. A repeated call in the task returns the error `Tool "create_plan" is not available…`, and without an Eco model, `Planning mode requires an Eco model to be selected.`.
- **R6.** During planning, `edit` is blocked, and `write` is blocked for existing paths, so only a new test or repro script can be created. The error is `Planning mode is read-only until report_plan…`. `bash` and other extensions' tools are not restricted; their "read-only" mode relies on instructions, as in Junie.
- **R7.** The planning limit is 50 completed planner turns after `create_plan`. The turn that calls `create_plan`, failed or aborted turns, and provider attempts that Pi retries do not count. After 45 completed turns, Junie's warning is appended to exploration tool results. The 50th planner request offers only `report_plan` and requires it via named tool choice on Responses models and Claude Opus 5 (without thinking on that request). For Claude models that do not support forced tool choice, it offers the tool without requiring it.
- **R8.** `report_plan` takes the required `plan` and `summary`. `summary` is one simple sentence in the language of the request, without headings, markdown, or prefixes like "Plan:". Outside planning and with an empty `plan`, an error is returned. Success restores the original tools without `create_plan` and `report_plan` and returns the plan with an `IMPLEMENT FROM CREATE_PLAN` block; `summary` is stored in `details.summary`.

Display:

- **R9.** Both tools draw their own row without a frame (`renderShell: "self"`). `create_plan` shows `Planning…`. `report_plan` shows `Writing the plan…` while the arguments stream, and `● <summary>` afterwards. The expanded row (ctrl+o) shows the planning instructions or the full plan; errors are shown in the error color.
- **R10.** If `summary` is missing or empty (old sessions), the first line after the plan's `Goal` heading is shown, and without it, the first line that is not a heading. Whitespace is normalized, and the length is limited to 200 characters with `…`.

Implementation and routing:

- **R11.** After a successful `report_plan` in the current task, subsequent main agent requests go to `gpt-6-luna` with `high` reasoning, and if it is unavailable, to `claude-haiku-5-5`. If neither is available, everything stays on the main model with the selected level.
- **R12.** Before a request, the `context` hook replaces the completed planning with a single message: from the `create_plan` result to the `report_plan` result, only the `create_plan` result with the plan and `IMPLEMENT FROM CREATE_PLAN` remains. Assistant responses and exploration tool results are not sent to the implementation model, while user messages and custom messages (clarifications) are kept. The session file is not changed.
- **R13.** A continuation (`continuation`) on the model of the previous response keeps that response's reasoning level. A retry after an error (`retry`) goes to the same model and level that failed.
- **R14.** A completed implementation turn counts as failed if all its tool calls returned an error or it has neither calls nor text. A provider error is not counted: Pi drops the failed response from the context and retries the request on the same model (R13) or ends the run. After three failed turns in a row, one request goes to the main model, then the route returns to the implementation model.
- **R15.** If the turn limit is reached without an accepted `report_plan`, the same task continues on the main model with the original tools except `create_plan` and `report_plan`. In the model's context the exploration is folded into an error result for `create_plan` (`ERROR: create_plan ran out of steps before reporting a plan`), even if the last planner turn returned only text. The full exploration remains in the transcript. If the run instead settles or a new prompt interrupts planning before the limit, the original tools are restored; on `session_start` the original tools of unfinished planning from a saved session are restored too. The next task starts on the main model and can plan again.
- **R16.** The session model and other extensions' `ctx.model` remain the Eco pair. Pi does not record physical switches and does not send `model_select`, while the footer and assistant messages show the physical model of the request.
- **R17.** Requests with `reason: "direct"` (not from the main agent loop) go to the implementation model: with `high` if it is not the main model, otherwise with the selected level.
- **R20.** A provider error that Pi retries automatically (overload, rate limit, 5xx) does not end planning. Pi emits `agent_end` after the failed attempt and continues the same run, so planning and its tools, including `report_plan`, are kept until `agent_settled`. In the eval, the reset on `agent_end` left 11 of 100 planners without `report_plan` after a `500` from the provider, and they did the whole task on the main model.
- **R21.** The Eco rule (R4) is written to `systemPromptOptions.sections.model_mix`, which Pi renders as `<model_mix>…</model_mix>`; `before_agent_start` does not return a `systemPrompt`. Pi forces a returned prompt as is, so the guidelines and sections added by handlers registered later were dropped: in the eval of 2026-11-20 the bash timeout guideline (COST-13) never reached the model on an Eco pair.

Phase texts:

- **R18.** The planning instructions (the `create_plan` result), in addition to Junie's `ExplorePlanPromptProvider`, require: a minimal change radius without incidental refactorings (verbatim from Junie); a fix where the behavior is defined, preserving working logic and public contracts; a repro test that checks the result the task requires, not what the intended implementation will return. In the plan's `Tests` section, the expected result is added to the scenario, plus a `validation` item with Junie's proportional test-scope rule verbatim (see [research](../../research/junie-model-mix.md#test-scope-and-trivial-bugs)), without requiring tests of every affected module.
- **R19.** The `IMPLEMENT FROM CREATE_PLAN` block (the `report_plan` result and the collapsed `create_plan` result, R8, R12) states that planning is complete and that `create_plan`/`report_plan` were removed on purpose. It is followed by an `IMPLEMENT → VALIDATE` section: steps 5–8 of the `[CODE]` workflow from `ExplorePlanPromptProvider` (minimal changes, Execute & Validate Tests, a ban on weakening failed tests). The `Bug/Error` rule and proportional test-scope rule are copied verbatim from Junie's `[CODE]` workflow (see [research](../../research/junie-model-mix.md#test-scope-and-trivial-bugs)): a reproduction test/script is expected to fail before the fix, with a quick manual check allowed for trivial bugs (typos, obvious logic errors); test scope starts narrowly and expands for complex or high-risk changes, without requiring tests of every changed module. In Junie, the implementation model gets this workflow through its system prompt (`implementSystemMessage`), but here the system prompt is not changed.

## Out of scope

- A separate planner subagent with its own system prompt and sandbox: planning is a phase of the main session.
- A separate `StepSummarizer` call for the plan row: the planning model writes `summary` itself, without an extra request.
- A sandbox for `bash` and other tools during planning.
- Eco for models of other providers.

## Compatibility

- Pi API: `registerVirtualModel` with `route()`, `registerTool`/`defineTool`, `setActiveTools`, hooks `session_start`, `before_agent_start`, `message_end`, `tool_call`, `tool_result`, `turn_end`, `before_provider_request`, `agent_settled`, and `context`. Pi internals are not patched. Junie-style row rendering is completed by [junie-ui](../../../../junie-ui).
- The router stores no state on the session branch (`pi.virtual-model-state`): the task's phase and the failed turns of R14 come from the planner, which counts the turns on `turn_end` and starts every run anew. Router state saved by older sessions is ignored.
- **Exception to [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md), history.** The planning collapse (R12, R15) uses the temporary `context` hook rather than persistent `context_edit` entries. The full exploration stays in the session file. After an accepted plan, the implementation model starts with a cold cache anyway; after exhaustion the collapse can invalidate the planner's cached history once. A hidden boundary message records the exhaustion and permits continuation even after a text-only planner reply.
- **Exception to COST-ADR-01, prompt.** The set of active tools changes for the duration of planning (R5–R8), which resets the prefix cache only at phase boundaries. The Eco rule itself is an ordinary prompt section (R21) and keeps other extensions' prompt changes.
- If `--tools` lacks `create_plan` and `report_plan`, planning is unavailable (R4).
- Grok through JetBrains AI does not always follow a named tool choice (R7): told to call `read` by the tool choice and not to call tools by the prompt, `grok-4.6` called it in three of six runs on 2026-11-22 and otherwise wrote text without stopping, until a provider error or a timeout. A last planner turn like that ends planning without a plan (R15).
- The cheap model client maps the Eco pair to a physical model (COST-01.R2).

Differences from the plan in `plan/model-mix.md` (the code prevails):

- Fallback to the strong model: in Junie, after 3 failed attempts within one step; here, after three failed turns in a row (R14), because Pi has no step attempt loop.
- `explore_plan` is renamed to `create_plan`, as in Junie `main`.
- The model is switched via a virtual model and `route()`, not via `setModel`, so the user's choice does not change (R16).

## Settings

- Selecting the `jetbrains-ai/<id>-eco` model in Pi's picker or via `--model`. There are no separate keys.

## Verification

- The live test `model-mix.integration.test.ts` on `grok-4.6-eco` checks the `grok-4.6 → gpt-6-luna` route, working bash and blocked overwriting during planning, that the exploration does not reach the implementation request, the texts of both phases in provider requests, and the saved virtual session model (R3, R5, R6, R8, R11, R12, R16, R18, R19). A separate test checks that the tools are hidden for a regular model (R4). Another one has the test extension fail the first planning request once with a retryable `503` and checks that the retried planning requests still offer `report_plan` and no `edit`, and that the plan is implemented on `gpt-6-luna` (R20).
- Live limit tests drive `grok-4.6-eco` through all 50 planner turns. They check the final request's tool choice and that only an accepted plan routes to Luna; a text-only final turn continues on Grok with the error and editing tools, and the next task can plan again (R7, R11, R15).
- `bash-guidance.integration.test.ts` checks on `grok-4.6-eco` with Pi's default prompt that the first request carries the `<model_mix>` section next to the bash timeout guideline and another extension's guideline (R21); with the returned `systemPrompt` both guidelines were missing.
- The effect of R18 and R19 on solution quality is verified only by rerunning the eval. The original failures: `jetbrains-ai-platform-1760` (the test was fitted to the implementation, the model looked for the missing `create_plan`), `code-engine-129` (a fix in helper code instead of the providers, a failed broad run was ignored), `YouTrack-9024` (working logic was rewritten).
- Verified manually:
  - R1 and R2 — the catalog;
  - R9 and R10 — rendering;
  - R13, R14, and R17 — routing branches.

## Open questions

- Which requests Pi 1.5.2 marks with `reason: "direct"` (R17) is not documented in the code; the route for them is chosen conservatively.
