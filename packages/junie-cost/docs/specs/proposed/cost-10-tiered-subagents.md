---
id: COST-10
title: Subagents with model tiers
package: junie-cost
status: deferred
pi: 1.5.2
depends: [COST-05]
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-10. Subagents with model tiers

## Goal

The main agent delegates subtasks to a subagent on the cheapest model tier that can handle them and gets back short findings rather than full files. Deferred: not part of the first version.

## Behavior

- **R1.** The `spawn_subagent` tool accepts `task`, `mode` (`CODE` / `EXPLORE`), `maxSteps`, and `tier`. Tiers: `fast` ~1x, `standard` ~2x, `strong` ~6x, `premium` ~15x; they map to models from `ctx.scopedModels`.
- **R2.** The tool description sets the rules:
  - choose the "cheapest capable tier";
  - code is written only on the same model (without `tier`);
  - `EXPLORE` returns findings, not files;
  - do not delegate reading known files, tasks of a couple of calls, or re-checking one's own work;
  - request summaries, not full files.
- **R3.** Before the subagent starts, the COST-05 capability filter runs synchronously, without thresholds, and only over skills.

## Out of scope

- Summaries of subagent runs in the COST-04 compaction.

## Compatibility

- The Junie references (`SpawnSubagentTool`, `SubagentModelParameters`, `SubagentCapabilityFilterLauncher`) are in [junie-cost-savings.md](../../research/junie-cost-savings.md). Cache rules are in [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md).

## Verification

Deferred, no tests.

## Open questions

- How to map tiers to `ctx.scopedModels` if the user has no models of the required tier.
