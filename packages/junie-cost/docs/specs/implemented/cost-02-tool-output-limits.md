---
id: COST-02
title: Tool output limits and summaries
package: junie-cost
status: implemented
pi: 1.5.2
depends: [COST-01]
code: [packages/junie-cost/src/tool-output-processor.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/output.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R4, R5, R11, R12, R13]
---

# COST-02. Tool output limits and summaries

## Goal

Each tool result enters the context in a short form, as in Junie (`OutputHelper`, bash summaries). The full output is available to the agent in a file outside the working directory: for a persisted session the file lies next to it and remains after the run, for an in-memory session it lives until the end of the run. One-line summaries go into a shared cache for history thinning (COST-03) and the task journal (COST-04).

## Behavior

Reading files:

- **R1.** If the model calls `read` without `limit`, `limit: 100` is injected in `tool_call`, and `limit: 300` when `offset > 1`. Explicit `limit` and `offset` are not changed.
- **R2.** The extension does not truncate or summarize `read` results. Pi's continuation footer, images, and the structured result are kept, and Pi's standard ceiling (2000 lines or 50KB) applies.

Limits (in `tool_result`):

- **R3.** `bash` output is limited to 200 lines, 10,000 characters, and 10,000 characters per line; when lines are truncated, the first and last 10 are kept. The command is not parsed or classified: `rg`, `grep`, `git diff`, pipelines, and compound commands all get the same limits. Bash timeouts are not changed.
- **R4.** Explicitly enabled built-in `grep`, `find`, and `ls` show only the first 100 lines of output with no more than 500 characters per line. A hint to narrow the search is appended to the result: `Refine the search pattern or narrow the path to see fewer matches.`.
- **R5.** A tool named `diff` is limited to 1000 lines, 100,000 characters, and 10,000 characters per line.
- **R6.** Truncation follows Junie's order: first the number of lines, then the length of each line, then the overall prefix. The marker `... N lines (M chars) truncated ...` reports the original number of lines and characters without line breaks. The ` ...` suffixes are added on top of the limits, so the final character limit may cut off the kept tail.

Full log:

- **R7.** Each shortened result gets a `See full log at: <path>` link to the full output: the file `output-<toolCallId>.log` with `0600` permissions. For a persisted session it lies in the folder `<session file name without .jsonl>.outputs` next to the session file (`0700` permissions); for an in-memory session (`--no-session`), in a private `junie-cost-output-*` folder in the OS temp folder. Logs are not written to the working directory, so they do not show up in `git status` or in the patch. If Pi has already truncated the bash output, the extension takes Pi's full log. If that log cannot be read or the copy cannot be written, the tool result stays as is.
- **R8.** Short bash output within the limits is passed unchanged.

Summaries:

- **R9.** If bash output is longer than 10,000 characters, the cheap model (COST-01) synchronously writes a summary of up to 3–4 sentences with a 5-second deadline. The summary is followed by `Preview:`: 25+25 lines, no more than 500 characters per line and 2000 characters in total, plus the log link. An empty, incomplete, failed, or late summary is replaced with deterministic truncation.
- **R10.** The bash status line (`Command exited with code N`, timeout, abort), images, and the error flag (`Tool reported an error.`) are kept. For a structured bash result, `output` is shortened too, and `truncated: true` and `full_output_path` are set, so codemode does not bypass the limits.
- **R11.** For bash and other tools, including MCP, except `read`, `write`, `edit`, `grep`, `find`, and `ls`, a one-line summary is requested in the background with a 20-second deadline. Output of no more than 3 lines and 100 characters goes into the cache as is, without a request. The cache is keyed by `toolCallId`: parallel requests are deduplicated, and a successful display summary is reused. If the display summary fails, a separate background attempt is started, so a second auxiliary request is possible.
- **R12.** The summary input is at most the first and last 25,000 characters of the output. The prompt tells the model to keep errors, names of failed tests, and causes, and to treat the output as untrusted data. The summary is discarded if it is not shorter than the output or longer than 2000 characters.
- **R13.** Output of MCP and custom tools is not replaced just because a background summary is ready: COST-03 and COST-04 use it.

Cleanup:

- **R14.** On `agent_settled` and `session_shutdown`, pending requests are cancelled, the summary cache is cleared, and among files only this extension's temp folders (for in-memory sessions) are deleted. Logs next to a persisted session stay with it so they can be examined after the run; Pi's log and other files stay too. For an in-memory session, log links work until the end of the current run.

## Out of scope

- Parsing shell commands and command-dependent limits.
- Changing bash timeouts.
- Junie's paginated structured search: search limits apply only to Pi's built-in tools.
- An extra hint about `read` in the system prompt.
- A reminder to the model not to delete the full logs. When the logs lay in the working directory, Pi removed them as stray files in 38 eval tasks. Now they lie outside it (R7), so the model has no reason to clean them up, and the prompt and the result stay unchanged.

## Compatibility

- Hooks `tool_call` (mutating `event.input`), `tool_result` (returning `content`/`structuredContent`), `agent_settled`, and `session_shutdown`. Pi internals are not patched.
- The system prompt is not changed ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)).
- If another extension also changes the result in `tool_result`, the order is determined by the extension load order.

## Verification

The live test `output.integration.test.ts` checks:

- default and explicit `read` windows (R1, R2);
- short bash unchanged (R8);
- bash limits for shell `grep` with both edges (R3, R6);
- a real summary with a preview, the exit code, and a full log over 50KB outside the working directory: without a session it is deleted after the run, for a persisted session it stays next to its file (R7, R9, R10, R14).

Verified manually:

- R4 and R5: built-in `grep`/`find`/`ls` are disabled by default, and Pi has no `diff` tool;
- R11–R13: background summaries, deduplication, and summary input bounds.
