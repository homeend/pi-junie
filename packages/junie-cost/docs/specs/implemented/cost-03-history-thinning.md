---
id: COST-03
title: History thinning with a cache cost decision
package: junie-cost
status: implemented
pi: 1.5.2
depends: [COST-02]
code: [packages/junie-cost/src/history-processor.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/history.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R3, R5, R6, R7, R8, R9, R11, R12]
---

# COST-03. History thinning with a cache cost decision

## Goal

Old tool results in a long session are replaced with short summaries or placeholders, as in Junie `UnlimitedStepsHistoryProcessor`. The replacement is made only when the input savings outweigh the cost of rewriting the prompt cache. The original messages in the session file and in the UI are not changed.

## Behavior

When and how:

- **R1.** The decision is made in `turn_end` and only for a completed turn (`outcome: "completed"`, not aborted). The handler makes no LLM requests and does not wait for summaries: it takes only those already ready in the shared COST-02 cache. Turns with an error or abort do not trigger thinning.
- **R2.** Thinning appends persistent `context_edit` entries that replace only the **content** of a result. The substitute is the cached summary or `[Earlier <tool> output omitted.]`, with `[Tool reported an error.]` added for error results. Call ids, tool-use blocks, assistant text and reasoning, error flags, and the original stored results are not touched. After a process restart, the edits are replayed through Pi's canonical context projection.
- **R3.** Results with images, results of unknown tools, and results already edited by any extension are not touched. Replacements that do not reduce the size are not applied either.

Retention windows are counted in **whole turns with tool calls**, not in individual calls:

- **R4.** `read` results older than the last 15 turns and results of search and other bash commands older than the last 10 turns can be replaced. For `write`/`create`, the last 5 turns are not touched, and in the older prefix the last successful write for each file (the path is resolved relative to `cwd`) is kept, while earlier ones are replaced. Failed writes are not replaced.
- **R5.** Built-in `grep`/`find`/`ls` count as search. A bash command counts as search if its first literal command is `rg`, `grep`, `find`, `fd`, or `ls`, possibly with a path to the executable. Commands further down the pipeline do not determine the category. The category does not affect bash output or execution.

Cost decision (numbers from Junie sources):

- **R6.** The next input is estimated as `usage.input + cacheRead + cacheWrite + output` of the last main response plus the characters of the new tail (user and tools) / 3. Without usage there is no estimate.
- **R7.** If there are no savings, nothing is done. If the estimate is above 90% of the model window (95% for windows larger than 300k tokens), any positive savings are applied.
- **R8.** Otherwise, the first 10 turns with tools are not thinned unless the cache has fully expired (R9). There is no artificial step limit.
- **R9.** If more than two cache TTLs (2 × 310 s) have passed since the last response, savings above 30,000 characters are enough. After one TTL, more than 60,000 characters are needed.
- **R10.** With a live cache, savings above 30,000 characters are required plus one of the conditions: savings > `recached suffix × write premium × model factor`; savings > `150k × factor` with history > `300k × factor` and savings > `0.7 × suffix × premium`; history > `600k × factor`. The premium is 1.25 for Anthropic, otherwise 1. The factor is 2 for Anthropic and Google, 1.5 for xAI, 1 for others, and 4 for `claude-opus-5-5` and `claude-fable-5-1`. The family is determined by the api, provider, or model id, so gateways are recognized too.
- **R11.** The recached suffix is the stored characters from the first changed turn up to the last assistant response, excluding the current, not yet cached turn.
- **R12.** Time and usage are taken from `message_end` of a successfully completed main assistant response, not from auxiliary requests. `session_start` resets the known response time.

## Out of scope

- Removing call/result pairs and shortening assistant text.
- Rewriting the system prompt and temporary edits via the `context` hook.
- LLM requests and waiting for summaries: if there is no summary (for example, after a restart), a placeholder is used.

## Compatibility

- Hooks `session_start`, `message_end`, and `turn_end`. Edits are returned as `{ entries: [...event.entries, ...plan.entries] }`; Pi internals are not patched. Everything follows [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md).
- Reload, branching, and compaction go through Pi's canonical projection (`contextEntries`); there is no separate copy of the history.
- Other extensions' `context_edit` entries are respected (R3).

## Verification

- R1, R2, R4, and R10 are covered by the live test `history.integration.test.ts`. It checks both outcomes: a long seeded history is thinned, a short one stays unchanged. It also checks the next provider request, whole call/result pairs, the original messages, and replay after a restart.
- R3, R5–R9, R11, and R12 are verified manually: the live test does not go through all thresholds, categories, and cache ages.
