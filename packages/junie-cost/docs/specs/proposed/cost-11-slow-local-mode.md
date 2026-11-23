---
id: COST-11
title: Slow / local mode
package: junie-cost
status: deferred
pi: 1.5.2
depends: [COST-02, COST-03, COST-04, COST-05, COST-09, COST-10]
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md]
---

# COST-11. Slow / local mode

## Goal

On slow and local models, service LLM calls cost more than they save. The mode disables them and keeps only deterministic optimizations. Deferred: not part of the first version.

## Behavior

- **R1.** The mode is enabled by an extension configuration flag, and automatically for local models.
- **R2.** In this mode, the following are disabled:
  - COST-02 output summaries (deterministic truncation remains);
  - the LLM part of the COST-04 compaction (command recap);
  - the COST-05 filter;
  - the COST-09 new session suggestion;
  - COST-10 subagents.
- **R3.** COST-03 thinning works only by the rule of proximity to the window limit (COST-03.R7).

## Out of scope

- Changes to output limits and retention windows.

## Compatibility

- The Junie references (`forceSlowModelBehavior`, `LLM.isSlowModel`, `AgentParameters.slowMode`) are in [junie-cost-savings.md](../../research/junie-cost-savings.md).

## Settings

- The slow mode flag. The key is not defined yet.

## Verification

Deferred, no tests.

## Open questions

- By what criterion Pi should consider a model local.
