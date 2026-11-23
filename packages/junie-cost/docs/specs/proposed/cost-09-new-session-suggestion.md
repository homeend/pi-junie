---
id: COST-09
title: New session suggestion
package: junie-cost
status: deferred
pi: 1.5.2
depends: [COST-01, COST-04]
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-09. New session suggestion

## Goal

When the session context has grown noticeably and a new request is unrelated to any past task, the user is offered to start over or compact the history. This way the new task does not drag along expensive context. Deferred: not part of the first version.

## Behavior

- **R1.** The `input` hook computes context growth since the session start: `(totalInput − baseline) / contextWindow` from `ctx.getContextUsage()`. Below 5%, no LLM is called.
- **R2.** From 5%, one classifier call is made through the COST-01 client with the question `NEW_TASK=true/false`. The input is the new request and the list of past tasks from the COST-04 journal, without tool results. The call does not wait for compaction and writes nothing to the history.
- **R3.** The prompt requires "Default to NEW_TASK=false". `true` is allowed only if the request is unrelated to any past task.
- **R4.** On `true`, three options are offered via `ctx.ui`: start over, compact, continue. After "continue", the user is not asked again in this session.
- **R5.** "Start over" is performed by a command, because `ctx.newSession()` exists only in `ExtensionCommandContext`. "Compact" calls `ctx.compact()` with the strict COST-04 summary.

## Out of scope

- Automatically starting a new session or compaction without the user's choice.

## Compatibility

- The service call runs without cache and with minimal reasoning ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)).
- The Junie references (`NewSessionSuggestion`, `StandaloneTaskRouter`, `SessionDialogs`) are in [junie-cost-savings.md](../../research/junie-cost-savings.md).

## Verification

Deferred, no tests.
