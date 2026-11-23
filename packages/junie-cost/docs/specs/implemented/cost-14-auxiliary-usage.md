---
id: COST-14
title: Usage of cheap-model requests in the session
package: junie-cost
status: implemented
pi: 1.5.2
depends: [COST-01, COST-02, COST-04]
code: [packages/junie-cost/src/summarization-client.ts, packages/junie-cost/src/tool-output-processor.ts, packages/junie-cost/src/compaction-summary.ts]
tests: [packages/junie-cost/test/output.integration.test.ts, packages/junie-cost/test/compaction.integration.test.ts, packages/junie-cost/test/history.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-02-usage-entries-via-session-manager.md]
manual: [R3, R4, R6]
---

# COST-14. Usage of cheap-model requests in the session

## Goal

Every request made through the cheap-model client (COST-01) is recorded in the session with its tokens and price, so Pi's own cost accounting (session stats, the cost breakdown, Pi's and junie-ui's footers) and the eval harness that reads the session include the whole cost of a run. Before this spec the tool output summaries (COST-02) never entered the session, and their usage was dropped in `summarize` of `src/tool-output-processor.ts`. In Pi eval run 8 (TeamCity build 7690821) there were about 3,500 such requests, roughly $1.2 of a $32.14 run. The compaction retelling (COST-04) stored its usage in the compaction entry, but only when the compaction completed. Junie counts every such request in its run cost: [junie-cost-savings.md](../../research/junie-cost-savings.md#cost-14-usage-of-tool-output-summaries).

## Behavior

- **R1.** `createSummarizationClient` records every response it receives from `ctx.modelRegistry.complete` as one Pi `usage` entry with the caller's kind, the response's provider and model (`responseModel` when the provider reports it) and Pi's usage of that response (tokens and `cost`). The entry is written before the client checks the response, so it is also written for responses that the client then rejects (stop reason other than `stop`, e.g. cut by `maxTokens`), for responses that arrive after the deadline or cancellation, and whether or not the caller uses the text, since the request was billed.
- **R2.** The entry is appended when the response arrives, one per request, as Junie records each request (`ExecutionContext.recordUsage`). Nothing is lost if the process is killed mid-run, e.g. by an eval timeout.
- **R3.** Nothing is recorded when the caller makes no auxiliary request, when no response comes back (no model, the request throws), or when the response reports no tokens at all (input, output, cache read and cache write are all zero), as for a request aborted before the provider reported usage.
- **R4.** The entry is written with `SessionManager.appendUsage`, which Pi uses for cache warming but leaves out of the extension's `ReadonlySessionManager` type ([COST-ADR-02](../../decisions/cost-adr-02-usage-entries-via-session-manager.md)). If the method is missing, or appending throws (for example, a late response after the session was replaced), the usage is not recorded and the caller's response is unaffected. With `--no-session` the entries stay in the in-memory session.
- **R5.** Kinds: `tool_output_summary` for the summaries of COST-02, both the display summary of large bash output and the background summaries for history thinning; `compaction_summary` for the command retelling of COST-04. The compaction entry carries no `usage`, so the retelling is counted once.
- **R6.** `usageKind` is a required option of `SummarizationOptions` (COST-01.R9), so requests that other extensions make through the shared client are recorded too, under their own kind.

## Out of scope

- A custom entry as a fallback: Pi and junie-ui do not count custom entries, so it would only hide the gap.
- `usage` of the `tool_result` result for the display summary: Pi replaces that field instead of adding to it, and background summaries arrive after the result is stored, so one mechanism covers both.
- The eval harness: `projects/eval-metrics/src/eval_metrics/external_agents/parsers/pi.py` in `swebench_matterhorn` reads only assistant messages. Reading `type: usage` entries and `usage` of compaction entries is a separate change there and needs the user's agreement first.
- Requests that do not go through the client: Pi's own compaction, other extensions' direct calls, Eco planning requests (COST-15).
- A per-run aggregate or a request count: the number of entries is the request count.

## Compatibility

- A `usage` entry is not sent to the model and is hidden in Pi's tree view and chat (only `cache_warm` usage is shown), so the prompt cache is unaffected ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)). The entry is small (a few numbers); no outputs are stored in it.
- Pi itself appends `usage` entries during a run (cache warming), so an entry between a tool result and the next assistant message is expected by Pi and by the task journal. A retelling entry is appended inside `session_before_compact`; Pi appends the compaction entry after the handler returns, so the usage entry precedes it and does not enter the context.
- Pi counts the entries in `getSessionStats()`, in `getUsageCostBreakdown` under `jetbrains-ai/<model>` and in its footer; junie-ui's footer (`packages/junie-ui/src/footer.ts`) counts them without changes.

## Settings

None.

## Verification

- Live tests in `test/output.integration.test.ts`, persisted sessions:
  - a bash command with long output triggers one display summary, and the second command's short output needs none; the session has exactly one `usage` entry with kind `tool_output_summary`, provider `jetbrains-ai`, non-zero input and output tokens and `cost.total` > 0 (R1, R2);
  - a bash command with 20 short lines triggers only a background summary, kept alive by a second `sleep 10` call; the session has exactly one `tool_output_summary` entry with non-zero output and cost (R1, R5).
- Live test in `test/compaction.integration.test.ts`: the automatic compaction that retells commands leaves one `compaction_summary` entry and a compaction entry without `usage`; the next compaction that reuses the retelling adds none, and a new retelling adds one more (R5).
- Persisted-session tests in `test/compaction.integration.test.ts` and `test/history.integration.test.ts` assert there are no `usage` entries for short task outputs, Pi's default mid-task compaction, on-demand compaction that uses only journal data, or history thinning over `read` results.
- R3, R4 and R6 are verified by reading the code: the entry is written inside the client's request, skipped for all-zero usage, only if `appendUsage` exists, inside its own `try`; `usageKind` is a required field.

## Open questions

- Propose a public `pi.appendUsage(kind, provider, model, usage)` for extensions in Pi; then R4 needs no undeclared method.
