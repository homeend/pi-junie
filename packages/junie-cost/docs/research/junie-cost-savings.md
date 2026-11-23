# Token savings in Junie: references for junie-cost

The Junie sources live in `~/Work/junie-agent-manual`; the paths below are relative to that folder.

This document collects how Junie saves tokens and links to implementation files and key symbols. Plugin requirements are described in the specs in [packages/junie-cost/docs/specs/](../specs/). The common rules for preserving the cache are in [COST-ADR-01](../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md).

## What Pi already does itself

The plugin does not repeat this:

- prompt caching and `prompt_cache_key`, message threads, cache warming;
- `sections` / `selectedTools` patches without resetting the cache;
- lazy loading of skills;
- MCP tools in `exposure: "codemode"` by default, without schemas in the request;
- compact-and-retry on overflow;
- `tool_search` + `exposure: "deferred"`;
- parallel tool execution;
- auto-compaction at the `contextWindow − reserveTokens` threshold.

## Common rules (cache)

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/AbstractAutoModeAgentWorker.kt`: a task continues via `<issue_update>`, `## ISSUE DESCRIPTION` is not rewritten.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/AbstractIssueAgentWorker.kt`: `updateCapabilitiesContext` (capabilities arrive as a separate user message), `PromptCacheContext`, the system prompt is set once per task.
- `core/llm/src/main/kotlin/com/intellij/ml/llm/matterhorn/core/llm/anthropic/AnthropicChatRequestBody.kt`, `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/MatterhornChat.kt`: `cache_control` on the system prompt, `shouldAddCachePoint`.

## COST-01. Cheap model client

Spec: [cost-01-aux-model-client.md](../specs/implemented/cost-01-aux-model-client.md).

- `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/CapabilityFilterModel.kt`: `ModelParameters.forCapabilityFilter` picks a cheap model per provider, minimal effort, no `budgetTokens`.
- `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/DefaultModelRequirements.kt`: `DefaultSummarizationSpec`, `ToolCallSummarizationSpec`, `ToolCallOutputSummarizationSpec`, `DefaultRouterSpec`, `limitOutputTokenForAnthropic`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/capabilityFilter/CapabilityFilterWorker.kt`: `getModelParameters` picks the model for the auxiliary call.

## COST-02. Tool output limits and summaries

Spec: [cost-02-tool-output-limits.md](../specs/implemented/cost-02-tool-output-limits.md).

- `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/helpers/OutputHelper.kt`: `truncateLongOutput`, `truncateLongOutputPersistingFullOutputIfNeeded`, `deleteTempOutputFiles`, the message text with a link to the full log.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/AgentAction.kt`: `DEFAULT_MAX_NUM_LINES`, `DEFAULT_OUTPUT_LIMIT`, `DEFAULT_MAX_LINE_LEN`, `DEFAULT_FILE_WINDOW`, `DIFF_MAX_NUM_LINES`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/tools/BashToolActionNew.kt`: bash limits, `DEFAULT_TIMEOUT_SECONDS`, `LONG_RUNNING_TIMEOUT_SECONDS`, `LONG_RUNNING_COMMAND_PATTERN`, summarizing large output, a 25 + 25 line preview. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/ToolAgentAction.kt`: `SUMMARIZATION_THRESHOLD`, `SUMMARIZATION_TIMEOUT`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/open/OpenFileAgentAction.kt`, `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/open/ScrollAction.kt`, `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/open/OpenEntireFileAgentAction.kt`: 100 / 300 line windows and falling back to a window for large files.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/search/RegexSearchTool.kt`: `RegexSearchAction`. In Junie, search is a separate tool with a page of 100 results and a `skip` parameter.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/ToolSummaryService.kt`: `launchToolSummarization`, `TOOL_SUMMARY_TIMEOUT_MS`, `enrichStateWithSummaries`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/ToolCallSummarizer.kt`: the summary prompt and skipping short output.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/Summarization.kt`: `summarizeBashOutput`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/NoOpSummarizer.kt`: fallback to truncation.

## COST-03. History thinning

Spec: [cost-03-history-thinning.md](../specs/implemented/cost-03-history-thinning.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/UnlimitedStepsHistoryProcessor.kt`: `shouldCompact`, `dropActionsFromPrefixKeepingTail`, `deduplicateCreateActionsInTail`, `calcNextInputTokens`, `findCommonStartPart`, all constants.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/AgentObservationPruning.kt`: `withRetainedRecords`, `assertNoOrphanedToolUses`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/AbstractAutoModeAgentWorker.kt`: `compressAgentStateInsideSteps` is called after each step.

## COST-04. Task journal and compaction summary

Spec: [cost-04-task-journal-compaction.md](../specs/implemented/cost-04-task-journal-compaction.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/MainAgentState.kt`: state between tasks — `lastAgentPatch`, `lastSessionHistorySnapshot`, `observations`, `isProcessed`, `compressBeforeNextTask`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/HistoryCompressionManager.kt`: `launchCompressHistory` (in the background), `runOnDemandCompression` (the hard variant).
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/MainAgentHistoryCompressor.kt`: `forceCompress`, `toAgentStateForCompression`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/CompressHistoryProcessor.kt`: `printAllCode`, `collectChanges`, `summarizeOtherCommands`, `compactIfNeeded`, `collectRejections`, a tail of 2 observations.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/PreviousTasksProcessor.kt`: `processPrevTasks`, `truncatePrevTasks` (10 tasks, solutions for the last 5).
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/SubagentsProcessor.kt`: compressing subagent runs by level.
- `ej-app/cli-standalone/src/main/kotlin/com/intellij/ml/llm/matterhorn/ej/app/cli/standalone/tui/app/state/ContextCompression.kt`: `/compact`, `requestContextCompression`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/MainAgent.kt`: `resolveAndRunAgent`, the `canResume` rule (if the agent and model are the same, the history continues without compression).

## COST-05. Capability filter

Spec: [cost-05-capability-filter.md](../specs/proposed/cost-05-capability-filter.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/CapabilityFilterLauncher.kt`: launch with a 5 s timeout, `restoreFilteredCapabilitiesFromState`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/TaskRequestFlags.kt`: `skipCapabilityFiltering`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/capabilityFilter/CapabilityFilterExecutor.kt`: `buildSystemMessage` (prompt), `findDynamicDescriptionLimit`, `parseRelevantIndices`, fallbacks.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/tasks/CapabilityFilterAgentTask.kt`: `CapabilityType`, `getSizeThreshold` (thresholds).
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/capabilityFilter/FilteredCapabilitiesContext.kt`: `shouldIncludeCapability`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/FilterableBuiltInTool.kt`: rarely used built-in tools.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/prompts/AgentSkillsPrompt.kt`: `buildAvailableSkillsList`, the "Hidden Skills" section. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/skills/AgentSkill.kt`: `extendedDescription` (description and section headings). `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/skills/resolver/AgentSkillsContext.kt`: `resolveFilteredAgentSkills`, `resolveHiddenAgentSkillNames`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mcp/CapabilitiesContext.kt`: `buildCustomAgentsSection` ("Hidden Custom Agents"), `buildCapabilitiesContext`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/subagents/SubagentTypeCatalog.kt`: filtering custom agents.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/EnableMcpTool.kt`: the template for `enable_capability` (in Junie it returns only MCP servers). `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/skills/AgentSkillReadDocAction.kt`: lazy skill reading.

## COST-06. Eco mode (Model Mix)

Spec: [cost-06-eco-mode.md](../specs/implemented/cost-06-eco-mode.md). Detailed breakdown: [junie-model-mix.md](junie-model-mix.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/modelmix/ExplorePlanAction.kt`: the `explore_plan` tool and handing the task over to the implementation model.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/modelmix/ModelMixContext.kt`: `switchToImplementModel`, `shouldStartOnImplementModel`, `IMPLEMENT_FALLBACK_NUM_ATTEMPT`.
- `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/DefaultModelRequirements.kt`: `ModelMixImplementSpec`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/prompts/AbstractPromptProvider.kt`: `modelMixBullet`.

## COST-07. Prompt section on parallel calls

Spec: [cost-07-parallel-tool-calls.md](../specs/proposed/cost-07-parallel-tool-calls.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/prompts/AbstractPromptProvider.kt`: `buildParallelToolCallsSection`.

## COST-08. Memory notes

Spec: [cost-08-memory-notes.md](../specs/proposed/cost-08-memory-notes.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/PlanUtil.kt`: `nextResponseWarning` — `<updates_request>` after 4 (or 3) steps without the block, the request texts.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/prompts/AbstractPromptProvider.kt`: the `<UPDATE>` / `<PREVIOUS_STEP>` rule in the system prompt.

## COST-09. New session suggestion

Spec: [cost-09-new-session-suggestion.md](../specs/proposed/cost-09-new-session-suggestion.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/NewSessionSuggestion.kt`: `NEW_SESSION_SUGGESTION_THRESHOLD`, `isContextOverloaded`. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/ContextSizeTracker.kt`: `baselineTokens`, `totalInputTokens`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/router/StandaloneTaskRouter.kt`: `classify`, the condition for running detection. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/router/RouterTarget.kt`: `NEW_TASK_DETECTION_SECTION` (prompt).
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/RouterHistoryProcessor.kt`: a cheap representation of previous tasks without tool-result.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/SessionDialogs.kt`: `processNewSessionSuggestion` (three options). `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/NewSessionSuggestionContext.kt`: `dismissed`.

## COST-10. Subagents with model tiers

Spec: [cost-10-tiered-subagents.md](../specs/proposed/cost-10-tiered-subagents.md).

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/subagents/SpawnSubagentTool.kt`: parameters and description of `spawn_subagent`, model tiers.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/subagents/SubagentModelParameters.kt`, `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/subagents/SubagentSpawnResolution.kt`: picking the model by tier. The tier specifications are in `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/DefaultModelRequirements.kt`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/agents/issue/GeneralPurposeSubagentWorker.kt`: subagent execution.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/subagents/SubagentCapabilityFilterLauncher.kt`: a synchronous filter without thresholds.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/prompts/AbstractPromptProvider.kt`: `buildSubagentsSection` — when to delegate and when not to.

## COST-11. Slow / local mode

Spec: [cost-11-slow-local-mode.md](../specs/proposed/cost-11-slow-local-mode.md).

- `ej-app/cli-standalone/src/main/kotlin/com/intellij/ml/llm/matterhorn/ej/app/cli/standalone/runners/StandaloneAgentRunner.kt`: computing `forceSlowModelBehavior`. `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/ModelParameters.kt`: `LLM.isSlowModel`.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/AgentParameters.kt`: `slowMode` and the list of what it disables.
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/mainAgent/MainAgent.kt`: skipping the filter and background compression. `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/history_processors/UnlimitedStepsHistoryProcessor.kt`: `slowMode` in `shouldCompact`.

## COST-14. Usage of tool output summaries

Spec: [cost-14-auxiliary-usage.md](../specs/implemented/cost-14-auxiliary-usage.md). Read at `origin/main` 29fd112803.

- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/actions/tools/BashToolActionNew.kt:447`: a large bash output is summarized by `DefaultSummarizer.summarizeBashOutput` with the action's `ExecutionContext` (`ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/Summarization.kt:62`).
- `ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/OutputSummarizer.kt:122`: the request goes through `context.summarizationContext().sendToGrazie(…)`; `summarizationContext` is a dedicated or the same `ExecutionContext` (`ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/summarization/StepSummarizer.kt:29`).
- `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/ExecutionContext.kt:263`, `:287`: every `sendToGrazie` response calls `recordUsage`, which adds its tokens and cost to the artifact statistics, one request at a time. The summary is made inside the step's tool call, so its cost is part of the step statistics that Junie reports as `modelStatsCost` (`ej-core/src/main/kotlin/com/intellij/ml/llm/matterhorn/agent/AbstractIssueAgentWorker.kt:1008-1015`).
- The eval harness reads Pi sessions in `swebench_matterhorn/projects/eval-metrics/src/eval_metrics/external_agents/parsers/pi.py:32-36`: only `type: message` entries of assistant messages.
