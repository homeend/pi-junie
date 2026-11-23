---
id: COST-04
title: Task journal and compaction summary
package: junie-cost
status: implemented
pi: 1.5.2
depends: [COST-01, COST-02]
code: [packages/junie-cost/src/task-journal.ts, packages/junie-cost/src/compaction-summary.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/compaction.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R7, R16, R18]
---

# COST-04. Task journal and compaction summary

## Goal

Pi's standard compaction asks the main model to write a summary, which is expensive. Between tasks, the extension builds the summary in code from facts recorded during the work, like Junie `CompressHistoryProcessor`. The main model is not called for this, and the cheap model is called at most once.

## Behavior

Journal:

- **R1.** In `agent_before_settle` with `outcome: "completed"`, one `custom` entry with `customType: "task-journal"` is appended. It covers all branch messages after the previous entry (the boundary is `throughEntryId`). The model does not see custom entries, and they cost no tokens.
- **R2.** `requests` are the texts of user messages. `solution` is the last assistant response without tool calls, completed with `stopReason: "stop"`.
- **R3.** Before the first `edit`/`write` of a file in a task (`tool_call`), its content is saved. At the end it is compared with the disk via `generateUnifiedPatch`, and the result is written to `patch`, `created`, and `modified` (absolute paths). Changes made via bash are not included in the patch. Snapshots live in memory, so a task interrupted by a Pi restart has no patch.
- **R4.** `viewed` holds the line ranges of successful `read` calls. Without an explicit `limit`, the default window from COST-02.R1 is used.
- **R5.** `commands` holds bash commands collapsed by text, with a run counter. Each one stores one of three: a one-line summary from the COST-02 cache, a recap from an automatic compaction that ran before the entry was written, or an output fragment (25+25 lines, up to 2000 characters).
- **R6.** `rejections` holds calls that passed `tool_call` but produced no `tool_result` and ended with an error. `Operation aborted` results do not count as rejections.
- **R7.** An aborted or failed run gets no entry: its messages and file snapshots go into the next entry.

When the summary is used (`session_before_compact`):

- **R8.** The Junie summary is substituted when the last branch message is an assistant response without tool calls (the threshold before a new prompt or right after a response), as well as on manual `/compact`. Compaction inside a task, overflow with a turn retry (`willRetry`), no entries and no new messages, and any error or cancellation leave Pi's standard compaction.
- **R9.** The summary is built each time from all journal entries in the branch and never parses the text of a previous summary. A task not yet in the journal (Pi checks the threshold before `agent_before_settle`) is assembled in memory only for this summary. Pi's compaction in the middle of a task does not delete the journal, so the next Junie summary again contains all tasks.

Automatic summary:

- **R10.** Blocks follow Junie's order, each starting with `History processor:`:
  1. a compression note;
  2. `<previous_issue>` and `<previous_issue_solution>` of all tasks;
  3. viewed code;
  4. changes;
  5. commands;
  6. rejections.
- **R11.** Viewed code is printed in its current version from disk. Ranges closer than 20 lines are merged. Files shorter than 200 lines or viewed by more than 80% are printed in full. Files created in the session are skipped. If there are more than 10 files, more than 3000 lines, or more than 60,000 characters, only file names are printed.
- **R12.** Task patches are separated by `=== changes block separator ===`. Lines longer than 3000 characters are cut to 200. When 500 lines or 25,000 characters are exceeded, the last blocks that fit, at most 5, are kept, or the beginning of the last one.
- **R13.** Commands are printed as `` `cmd` (×N): summary ``. If there are more than 30 commands, the last 10 and the 20 most frequent are kept.
- **R14.** The last 20 rejections are printed with an instruction not to repeat them.
- **R15.** For commands without a summary, one request is made to the cheap model (COST-01) with Junie's prompt and a 30-second deadline. Recaps are stored in `details.commandSummaries` of the automatic compaction; the usage of that request is a separate `usage` entry of kind `compaction_summary` (COST-14.R5), and the compaction entry carries no `usage`. Rules:
  - commands from entries before the previous automatic compaction take its recap;
  - a command run later is recapped again;
  - all valid recaps carry over into each new compaction;
  - if the recap fails, an output fragment is printed.
- **R16.** `details` also stores `readFiles` and `modifiedFiles` for the whole session, so a later Pi compaction in the middle of a task does not lose them.
- **R17.** Manual `/compact` produces a hard summary via `forceCompress`: the last 10 tasks, solutions only for the last 5, and rejections. The model is not called. Only the last assistant response is kept verbatim, if it lies within the tail that Pi would keep anyway.
- **R18.** For the automatic summary, the verbatim tail is the one Pi selected (`preparation.firstKeptEntryId`, limited by `keepRecentTokens`).

## Out of scope

- Triggering compaction: the extension never starts it, including on a model change.
- Summaries for compaction in the middle of a task (left to Pi) and subagent summaries.
- Plan and user-question blocks: Pi has no built-in tools for them.
- Extending viewed ranges of edited files by 10 lines, as in Junie.

## Compatibility

- Hooks `session_start`, `tool_call`, `tool_result`, `agent_before_settle`, and `session_before_compact`. Pi internals are not patched.
- Pi keeps only the result of the last `session_before_compact` handler that returned one. Extensions that also replace the compaction summary are incompatible with this one.
- Pi does not mark blocked calls. A rejection is visible only if the blocking `tool_call` handler belongs to an extension loaded after this one.
- Junie has no journal; it parses the previous summary with regular expressions. Here structured entries are stored, and the summary is rendered from them again. The last task may end up both in the summary and in Pi's tail.

## Verification

The live test `compaction.integration.test.ts` checks:

- entries for one and two tasks (R1–R6);
- the automatic summary with the exact text and the next provider request, reuse of a recap and its replacement (R8, R10–R13, R15);
- compaction in the middle of a task left to Pi (R8, R9);
- manual compaction via the RPC `compact` with a restart (R14, R17).

R7, R16, and R18 are verified manually.
