---
id: COST-07
title: Prompt section on parallel calls
package: junie-cost
status: proposed
pi: 1.5.2
depends: []
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-07. Prompt section on parallel calls

## Goal

The model combines independent reads and searches into a single response. The task then takes fewer turns, and so the history is resent and cached fewer times.

## Behavior

- **R1.** A section `sections["parallel-tool-calls"]` is added to the system prompt. It says: make independent reads and searches in a single response; run dependent operations, edits, and installs sequentially; when in doubt, run sequentially.
- **R2.** The section text does not depend on the task or the session, so the prompt prefix stays stable and is cached.

## Out of scope

- Forced parallelization or reordering of calls.
- Changes to other prompt sections.

## Compatibility

- Only `sections` is used, not the whole `systemPrompt` ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)).
- If another extension already adds a similar section, the rules are duplicated; the section key is unique to this extension.
- The Junie reference (`buildParallelToolCallsSection`) is in [junie-cost-savings.md](../../research/junie-cost-savings.md).

## Verification

Not implemented yet. R1 — a test that the section is present in the sent system prompt. R2 — a comparison of the prompts of two requests.
