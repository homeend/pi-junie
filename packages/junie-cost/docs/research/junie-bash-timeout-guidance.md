# Bash timeout guidance: Junie and Pi

## Source snapshot

Junie checkout: `~/Work/junie-agent-manual`, branch `main`, commit `fe3d53c620` (2026-11-18). An attempt to update with `git pull --ff-only` on 2026-11-18 timed out after 60 seconds; this comparison uses the local commit, not a confirmed fresh remote main.

Junie paths below are relative to that checkout.

## Live Junie path

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/issue/StandaloneIssueAgentActionsResolver.kt:51,84`: `getActions` adds `createBashAction(readOnlyTools)` to the issue agent's tools.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/issue/BaseStandaloneMcpAwareActionsResolver.kt:143–167`: `createBashAction` selects `StandaloneBashToolAction` on non-Windows platforms; there is no feature flag around that branch.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/StandaloneBashToolAction.kt:12–19`: inherits `BashToolActionNew` without overriding its description.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/tools/BashToolActionNew.kt:215–224`: the tool's `docstring` includes the following instruction:

> `timeout` parameter: Choose the timeout greedily based on realistic estimates — do not use the maximum timeout as a default. Overestimating wastes session time needed for other commands.

History lookup: `git log -S 'Choose the timeout greedily'` for `BashToolActionNew.kt` identifies `ef8332b4ff` (`New BashToolActionNew to use ShellExecutionEnvironment`). The call chain above confirms the class is not merely historical code.

## Comparison and proposed adaptation

| Junie behavior (source) | Pi 1.5.2 mechanism | Extension proposal | Difference left |
| --- | --- | --- | --- |
| Instruction in the bash description (`BashToolActionNew.kt:224`, full path above) | Mutable `before_agent_start.systemPromptOptions` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:740–745`), `promptGuidelines` (`dist/core/system-prompt.d.ts:21–22`) | Append one constant bash-specific guideline without replacing the tool | Instruction is in the default prompt rules rather than the tool description; custom prompts retain Pi's rendering behavior |
| Numeric defaults and bounds: 60 seconds normally, 300 for recognized long-running commands, clamped to 20–3600 (`BashToolActionNew.kt:62–70,251–259`, full path above) | Optional timeout, no default (`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:16–30,101–110`) | Include the numbers as orientation only; convert values above 3600 from milliseconds (COST-13.R5) | No Junie defaults or bounds are enforced |

Pi renders and deduplicates guideline bullets in `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:31–65`; custom and forced prompts bypass these rules (`:78–87,125–128`). Only selected, non-hidden declarations are used for prompt rules (`:76–87`), so the proposal follows the same condition for bash.

Replacing the bash tool merely to change its description would add ownership and extension-order concerns. A `promptGuidelines` addition is smaller and follows [COST-ADR-01](../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md). The constant text does not introduce task-dependent prompt changes.

Junie's instruction does not name the unit; its `timeout` is in seconds as well (`BashToolActionNew.kt:62–70`). Pi's schema says "Timeout in seconds", yet in the eval run of 2026-11-18 models often passed milliseconds (`120000`–`300000` for gradle), probably a habit from harnesses whose bash timeout is in milliseconds. With the user's agreement, the guideline ends with one sentence naming the unit (COST-13.R4). In the eval run of 2026-11-20 that sentence did not reach Eco models (the Eco rule forced the whole system prompt, COST-06.R21), and 1389 of 3267 bash calls still passed values above 3600, mostly `10000` and `15000` on quick `ls`/`grep` commands and `120000` on gradle. Junie never sees such values because it clamps to 3600; with the user's agreement, junie-cost converts a value above 3600 from milliseconds to seconds before the call runs (COST-13.R5).

Contract: [COST-13](../specs/implemented/cost-13-bash-timeout-guidance.md). The user agreed to guidance with the same numbers for orientation and later to the millisecond conversion. The guideline explicitly distinguishes these reference values from Pi's actual defaults and runtime limits.