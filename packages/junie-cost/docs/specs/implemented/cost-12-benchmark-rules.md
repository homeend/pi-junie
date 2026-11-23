---
id: COST-12
title: Benchmark rules from JUNIE_BENCHMARK_RULES
package: junie-cost
status: implemented
pi: 1.5.2
depends: []
code: [packages/junie-cost/src/benchmark-rules.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/benchmark-rules.integration.test.ts]
research: [packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R4]
---

# COST-12. Benchmark rules from JUNIE_BENCHMARK_RULES

## Goal

On an eval run, Pi gets the same rules as Junie: the paragraph "IMPORTANT! This is a benchmark task…" that forbids taking the answer from git history, hidden tests, and caches. The eval pipeline passes the rules text in the `JUNIE_BENCHMARK_RULES` environment variable. Junie reads it as the `benchmark_rules` property (`ej-core/.../agent/util/EjProperties.kt:84`, `:315`) and appends it to the task right after `</issue_description>` (`AbstractPromptProvider.getIssueDescriptionAndInstructions`, `:857`). Without the rules, Pi solves the task under different conditions, and the comparison with Junie is unfair.

## Behavior

- **R1.** If `JUNIE_BENCHMARK_RULES` is set and not empty after `trim()`, the rules are appended after a blank line to the text of each new user request (`source` is `interactive` or `rpc`, including `pi -p`): `<task text without trailing whitespace>\n\n<rules>`. The variable is read on every request.
- **R2.** The rules go into the user message: this is how the model sees them, how they are stored in the session file, and how they are shown in the transcript. The system prompt is not changed.
- **R3.** Nothing is appended if the variable is not set or is empty after `trim()`, or if the request text already contains the rules (the runner added them itself).
- **R4.** Nothing is appended to messages that continue an ongoing task (`streamingBehavior` is `steer` or `followUp`), to messages from other extensions (`source: "extension"`), or to input starting with `/` (commands, skills, prompt templates: Pi expands them after the hook, and the rules would become their arguments).

## Out of scope

- Other differences in eval conditions: the project root listing (`PROJECT STRUCTURE`) and `<terminal_status>` after commands.
- Reading the `benchmark_rules` property from sources other than the environment variable.
- Changing agent behavior according to the rules: this is only text for the model.

## Compatibility

- Pi API: the `input` hook with a `transform` result. Pi internals are not patched.
- Per [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md), the system prompt is not touched: the rules go in the user message, and the prefix cache is not reset.
- Other extensions with an `input` hook get the already extended text if they are called after junie-cost. Pi handles their `handled` and `transform` results as usual.
- The task journal (COST-04) records the request together with the rules, because it stores the text of the user message.

## Settings

- `JUNIE_BENCHMARK_RULES` — the rules text. Set by the eval pipeline, not by the user.

## Verification

- The live test `benchmark-rules.integration.test.ts` checks via provider requests that rules with surrounding whitespace are appended once after a blank line and do not get into the system prompt (R1, R2), are not duplicated if already present in the task text, and are not added when the variable is empty (R3).
- R4 is verified manually: the live test does not reproduce steer and follow-up deterministically.

## Open questions

- Whether Junie appends the rules to task clarifications (`<issue_update>`) has not been checked in the code. Here they are appended to each new request, but not to messages sent during work (R4).
