# Model mix (Junie Mix) in Junie

The Junie sources live in `~/Work/junie-agent-manual` (HEAD `fbba9c92dd`, 2026-10-15). Unless stated otherwise, the paths below are relative to `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/` in that repository.

How the mechanism was ported to Pi is described in spec [COST-06](../specs/implemented/cost-06-eco-mode.md).

## In short

1. The main (strong) model gets the `create_plan` tool. If the task requires code changes, the system prompt tells it to call this tool first.
2. `create_plan` launches a **child agent** on the same strong model. The agent receives a copy of the parent's history and a tool set without editing tools, explores the code, and finishes with the `report_plan(plan)` tool.
3. The plan text is returned to the parent as the result of `create_plan`. From the next step on, the parent runs on the **implementation model** with its own system prompt and its own tool set.
4. If the implementation model produces an invalid tool call three times in a row within one step, the strong model makes the remaining attempts of that step.
5. Each new task starts on the strong model again.

The name "Eco mode" does not appear in the code. The user sees the model **"Junie Mix"**.

## Enabling

| Where | What |
|---|---|
| `core/.../llm/ModelParameters.kt`, `ModelOption.Specific.JETBRAINS_MIX` | The "Junie Mix" option: main model `LLM.GROK_4_5`, `modelMixEnabled = true`, `isInternalOnly`, `customSettingId = "junie-mix"`. The picker shows the price as half of the Grok 4.5 price (1.0/3.0 instead of 2.0/6.0), marked "estimate" |
| `ModelOption.defaultInternal = JETBRAINS_MIX` | Since 2026-09-10 this is the default model on internal builds (EAP/Nightly) |
| `ej-app/cli-standalone/.../StandaloneAgentRunner.kt:330` | `SelectedModelsContext.modelMixEnabled` is taken from the selected option |
| `util/EjProperties.kt:160-165` | `AgentParameters.modelMixEnabled` is set from `SelectedModelsContext`. The `model_mix_enabled` property (`MODEL_MIX_ENABLED` variable) overrides it in both directions |
| `core/.../llm/EffortLevel.kt:121` | With model mix, the main model's effort defaults to `Medium` if the model did not match one of the earlier branches |
| `core/.../llm/DefaultModelRequirements.kt:224` | `ModelMixImplementSpec`: only `GPT_6_LUNA`, `reasoningEffort = "high"` + `applyPrimaryDefaults()`. It is not redirected to the auxiliary Qwen (test in `AuxiliaryQwenRoutingTest`) |

History of the implementation model (`git log -L` on `ModelMixImplementSpec`):

| Date | Model |
|---|---|
| 2026-07-21 (`prewalk 3`) | Grok 4.5 |
| 2026-09-02 | Qwen3.6-27B (AI Platform) |
| 2026-09-16 | GPT-5.6-Luna, high |
| 2026-09-25 | GPT-6-Luna, high (current) |

## Context registration: `AbstractIssueAgentWorker.registerModelMixContext` (lines 199-221)

Called from `buildInitialAgentStateAndContext`, i.e. when the state of a new task is built, if all conditions hold:

- `agentParameters.modelMixEnabled == true`;
- `ModelMixImplementSpec` resolves (the model is available);
- the implementation model differs from the main one.

What it does:

- builds `implementParams = agentParameters.forModelMixImplement(implementModel)`: a different model, `parallelToolCalls`/`parallelSubagents` according to its capabilities, `useSubagents = false`, `modelMixEnabled = false`;
- builds the system prompt for the implementation model **in advance** (`createPromptProviderForModel(...).getSystemMessage`);
- registers `ModelMixContext(implementSystemMessage, implementAgentParameters, primaryModelParameters, useImplementModel = shouldStartOnImplementModel(issue))`.

`shouldStartOnImplementModel(issue)` is true if the task has a `PlanAttachment` — a plan approved by the user in the UI: TUI `AskSuggestPlanView` ("Confirm and implement"), `TaskView`, `GoalSubmission`, ACP sessions. Then the task goes straight to the implementation model, and `create_plan` is not offered.

## `ModelMixContext` (`modelmix/ModelMixContext.kt`)

- The `useImplementModel` flag (`@Volatile`) changes only one way, via `switchToImplementModel()`.
- `resolveActiveAgentParameters`, `resolveActiveModelParameters`, `resolveActiveSystemMessage` return the implementation profile after the switch and the main profile before it. Inside a subagent the main profile is always returned.
- `IMPLEMENT_FALLBACK_NUM_ATTEMPT = 3`.

Where the active parameters are used:

| Place | What is taken as active |
|---|---|
| `workers/AbstractAgentSingleStepWorker.buildResponse` (lines 139-143) | The step's `AgentParameters`; computed **once per step** and passed to `createLoop` |
| `ActionRequestProducerLoop.produce` (line 253) | The request's system prompt |
| `agents/issue/BaseStandaloneMcpAwareActionsResolver.activeModelParameters` | The model-dependent tool set: `apply_patch` for Luna instead of `search_replace`/`multi_edit` from Grok (commit `80c1cd017e`, MTRH-3189) |
| `AbstractIssueAgentWorker` line 995 | Warnings before the last steps |
| `history_processors/UnlimitedStepsHistoryProcessor.kt:42` | Cache timeout and thinning coefficients |
| `classification/EmptySubmitGuard.kt:35` | See the section on obsolete code below |

## The `create_plan` tool (`modelmix/ExplorePlanAction.kt`)

- The tool is called **`create_plan`**, although the class is still `ExplorePlanAction`: it was renamed on 2026-09-11 (`321c87b9f3`). The first version of the savings plan used the old name `explore_plan`.
- There are no parameters: "The task description is transmitted to the tool automatically".
- Description for the model: call it every time the task requires code changes; do not call it for Q&A, explanations, read-only analysis, or a "plan without implementation"; call it first, before its own exploration; do not call it again after a successful plan.
- `actionGroup = SUBAGENT`.
- Empty plan → `ActionResult.error("create_plan ran out of steps…/exited early…")`, no switch.
- Non-empty plan → `switchToImplementModel()`, the plan text becomes the result.

When it is offered (`StandaloneIssueAgentActionsResolver.shouldOfferExplorePlan`, lines 101-106): `modelMixEnabled` is on, there has been no switch yet, there is no `PlanAttachment`, the task is not `readOnly`, the task type is ISSUE/CODE/DEBUG (not CHAT).

Protection against a repeated call (`ActionRequestProducerLoop`, lines 64-65, 680-713): if the task's observations already contain a `create_plan` record, the tool is removed from the list. If the model calls it anyway, the call is rejected with the error "already used earlier in this task. Implement from the existing plan instead".

## Child planner agent (`modelmix/ExplorePlanRunner.kt`, `ExplorePlanActionsResolver.kt`, `ExplorePlanPromptProvider.kt`, `ReportPlanAction.kt`)

Child agent parameters:

- the same **main** model (`childModelParameters = agentParameters.modelParameters`);
- `modelMixEnabled = false`, `useSubagents = false`, `parallelSubagents = false`;
- `maxSteps = 50`, `forceSubmitOnLastStep = true`: on the last step `report_plan` is forced (`PlanUtil.resolveForcedTerminalToolName`), and shortly before that the warning "You are running out of steps for investigation stage…" arrives (`PlanUtil.kt:103`);
- registers `ModelMixContext.KEY = null` so as not to inherit the parent's profile;
- **receives a copy of the parent's observations** (`parentObservations`, commit `84cfe4e308`) and sees the whole task history;
- is launched via `runSubagentWorker`. Its steps do not get into the parent's history: only the plan is returned there.

Tools: the main agent's set without the `EDIT` group and without `create_plan` itself, plus `report_plan(plan)` as the only terminal tool. `create` and `bash` remain.

### When the planner reaches its limit

Checked against Junie `origin/main` at `29fd112803`:

- `ExplorePlanAction.kt:46–57` calls `ExplorePlanRunner`; `ExplorePlanRunner.kt:37–67` launches the child worker with 50 steps and `forceSubmitOnLastStep`. The parent's `create_plan` call is outside that budget.
- `ActionRequestProducerLoop.kt:377–415` selects the terminal tool on the final step and forces it on compatible models. `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/ModelParameters.kt:669,688–690` defines the relevant model capabilities. Claude Opus 5 can be forced and Junie omits thinking for that request (`core/llm/src/main/kotlin/com/intellij/ml/llm/matterhorn/core/llm/anthropic/AnthropicChatRequestBody.kt:195–212,257–269`); Claude models with the thinking-prefix check cannot be forced. Junie keeps the full planner tool set for Claude; Pi keeps its existing report-only final tool set for all Eco pairs.
- `modelmix/ExplorePlanAction.kt:59–73` accepts only `Submit` with nonempty output. For `ExitMaxIter`, the tool returns `ERROR: create_plan ran out of steps before reporting a plan` and never calls `switchToImplementModel()`. The test `ej-core/src/test/kotlin/com/intellij/ml/llm/matterhorn/agent/modelmix/ExplorePlanActionTest.kt:24–36` covers rejected and empty output.
- `ActionRequestProducerLoop.kt:67–68,218–223,701–730` excludes `create_plan` once there is a record of its use in the task, regardless of success. The parent does not get the child's exploration; it gets the `create_plan` error and stays on its main model.

Key system prompt rules (`ExplorePlanPromptProvider`):

- the agent is "pinned to [CODE]": the plan is written as a handoff **to itself**, so that it can continue the implementation later;
- **READ-ONLY UNTIL PLAN**: before `report_plan` it may only create a new repro test or script and must not touch anything existing;
- a typical exploration takes ~15 steps (`TYPICAL_INVESTIGATION_STEPS`), "a good working plan beats a perfect plan";
- plan format: 30–60 lines with the sections `Goal`, `Scope`, `Touch points`, `Approach`, `Tests`, `Created artifacts`, `Corner cases & risks`; verified facts only;
- `report_plan` is called when the specific files, classes, and methods are known and there is a working approach.

## After the plan is handed over

- `StandardObserverMessages.createExplorePlanGuidanceMessage`: after a successful `create_plan`, a `### IMPLEMENT FROM CREATE_PLAN` block is added as a separate user message. Its instructions: the plan is the source of truth; execute it step by step; reuse the facts and created artifacts; search the code only for a specific gap; do not re-explore, do not build a competing plan, do not call `create_plan` again.
- `ActionRequestProducerLoop.filterSubagentToolsAfterModelMixImplement`: after the switch, all tools of the `SUBAGENT` group are removed (commit `b22f5e8393`).
- The implementation model receives the same history: the request, the `create_plan` call with the plan as its result, and the instructions. Its system prompt and tool set are different, so the prompt cache is reset once at the switch.
- When the provider changes between messages (`ActionRequestProducerLoop`, lines 233-242), Junie adds a request to the prompt: models with `updateStatusRequired` are asked to critically evaluate the previous model's work via `update_status`, reasoning models get "Continue using result from previous steps". This is the general model-switching mechanism, not tied to model mix.

### Test scope and trivial bugs

Checked against local Junie `fe3d53c620cc` (2026-11-18); updating `main` timed out. The implementation system prompt is built through `AbstractIssueAgentWorker.registerModelMixContext` (`AbstractIssueAgentWorker.kt:222–224`), and its `[CODE]` testing rules come from `prompts/PromptInteractionMode.kt`:

- Line 269 expects a reproduction test/script to fail before the fix, but explicitly allows a quick manual check for trivial bugs (typos, obvious logic errors).
- Lines 279–280 limit tests to meaningful validation and keep scope proportional: start with narrowly targeted tests and expand to broader suites for complex or high-risk changes. They do not require running the tests of every changed module.

| Junie behavior (source) | Pi 1.5.2 mechanism | Extension behavior | Remaining difference |
| --- | --- | --- | --- |
| Proportional testing (`prompts/PromptInteractionMode.kt:279–280`) | Phase instructions in tool results | The plan's validation item and implementation instructions use line 280 verbatim; no all-module mandate | Tool-result delivery instead of the implementation system prompt; the plan item has a `validation:` prefix |
| Manual check allowed for trivial bugs (`prompts/PromptInteractionMode.kt:269`) | Implementation instructions in the `report_plan` result and folded `create_plan` result | Copy the entire `Bug/Error` rule verbatim, including the trivial-bug exception (COST-06.R19) | Tool-result delivery instead of the implementation system prompt |

## Fallback to the strong model (`ActionRequestProducerLoop.changeModelParametersForReflection`, lines 632-640)

This is **not** "return to the strong model after 3 failed attempts". The exact semantics are:

- within one step the agent makes up to `numReflections = 6` attempts to get a valid response (attempts 0–5);
- an attempt fails if the response could not be parsed, a call failed validation, or all calls were rejected (`handleParsingError`);
- starting from attempt #3, i.e. after three failed attempts by the implementation model, **the remaining attempts of this step** go to `primaryModelParameters`, while the system prompt stays the implementation one;
- the exception is attempts with assistant prefill: strong models reject a trailing assistant message;
- **the next step goes to the implementation model again.** `useImplementModel` is not reset; there is no global fallback.

## Between tasks

- `ModelMixContext` is created in `buildInitialAgentStateAndContext` for each new task with `useImplementModel = false`, so **each new task starts on the strong model**.
- `MainAgent.canResume` (lines 235-246) compares the main model (`agentParameters.modelParameters.model`), and for Junie Mix that is always Grok. So model mix by itself does not cause history compression between tasks.
- Resuming an **unfinished** task (`AbstractAutoModeAgentWorker.buildInitialAgentStateAndContext`, the resume branch) does not call `registerModelMixContext`. Judging by the code, such a resume runs on the strong model, and `create_plan` is blocked because its record is already in the observations. This is a conclusion from reading the code; the behavior was not checked live.
- A realtime follow-up, a message sent while the task runs, resumes the interrupted task this way (`mainAgent/MainAgent.kt:249–251`, `AbstractAutoModeAgentWorker.kt:79–101` in origin/main `de451b0f75`), so the rest of the task goes to the strong model too.
- In the summary of previous tasks (`history_processors/PreviousTasksProcessor.kt:174-180`) the plan is kept as a `<previous_create_plan>` block.
- `AgentObservationRecordMatching.TERMINAL_RECORD_ACTION_NAMES` contains `report_plan`.

## What looks like part of model mix but is obsolete or does not work

| Code | Why it is obsolete |
|---|---|
| KDoc of `ModelMixContext` ("typically Qwen"), comment in `ExplorePlanAction.kt:66` ("e.g. Qwen") | Since 2026-09-16 the implementation model is GPT-Luna |
| `classification/EmptySubmitGuard` (commit `abb8f454f7` "fix for mix models") | Fires only for `isRemoteQwen27B`; with the current implementation model it plays no part in model mix |
| The `isQwen27B`/`isAssistantPrefillSupported` branches in `ActionRequestProducerLoop` (restoring tool calls from text, prefill) | Added for Qwen as the implementation model and do not fire for Luna. The prefill exception in the fallback is dead too |
| The `ExplorePlanActionsResolver` comment about the "old prewalk PLANNING phase" | Refers to a removed phase; there is no prewalk code anymore (only this comment remains in `git grep`) |
| The class names `ExplorePlanAction`, `ExplorePlanWorker`, `agentName = "explore_plan"` | The tool was renamed to `create_plan`; the old name remains only in internal names |
| `.junie/skills/llm-proxies-and-models/SKILL.md` | Names the implementation model GPT_5_6_LUNA, while the code already uses GPT_6_LUNA |
| `AbstractAgentSingleStepWorker` and other `resolveActive*` inside subagents | Always return the main profile: model mix is off in subagents (`useSubagents = false` after the switch, `modelMixEnabled = false` for the planner) |
