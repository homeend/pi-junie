---
id: COST-05
title: Capability filter with re-enabling of hidden items
package: junie-cost
status: proposed
pi: 1.5.2
depends: [COST-01]
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-05. Capability filter with re-enabling of hidden items

## Goal

If the user has many skills, custom agents, or rare built-in tools, only those needed for the current task enter the prompt. The rest are shown as a single line of names, and the model can re-enable any of them. The filter, the representation of hidden items, and re-enabling are done in one commit: a filter without re-enabling simply takes capabilities away from the model.

## Behavior

Filter:

- **R1.** In `before_agent_start`, one call to the cheap model (COST-01) selects the needed skills, custom agents, and rare built-in tools. The deadline is 5 seconds under `Promise.race`. On a timeout, an error, or an unrecognized response, the filter is not applied.
- **R2.** Thresholds: skills ≥ 6, custom agents ≥ 3, rare built-in tools ≥ 1. A type below its threshold is shown in full. If no type passes its threshold, no LLM is called.
- **R3.** The input is a numbered catalog `N. **name**` with descriptions, grouped by type, plus the session's previous requests and the user's guidelines. Descriptions are truncated so that the average length is ≤ 200 characters; the limit is found by binary search.
- **R4.** The prompt follows Junie:
  - "Be conservative — when in doubt, select";
  - do not expand the set "for the future";
  - on a question about capabilities, select everything;
  - select what is explicitly named;
  - do not select what bash and file tools cover;
  - do not exclude capabilities marked as made for other agents.
- **R5.** The model answers with comma-separated numbers; only digits and commas are taken from the response.
- **R6.** The result is applied to `event.systemPromptOptions.skills`, to the agent catalog, and to `selectedTools` (only for rare built-in tools). It is saved with a `pi.appendEntry("capfilter", …)` entry. If the user continues an unfinished task, the filter is not rerun.

Representation of hidden items:

- **R7.** A visible skill is shown as `name` + `description` (up to 1024 characters) + up to 20 section headings of the body. Hidden skills are listed by name only in the `sections["hidden-skills"]` section with the note "hidden by the capability filter as irrelevant to the current task (you shouldn't use them)".
- **R8.** A visible custom agent is shown as `name: description`, hidden ones by name only in the `hidden-custom-agents` section.
- **R9.** Hidden rare built-in tools are removed from `selectedTools` or exposed as `exposure: "deferred"`.

Re-enabling hidden items:

- **R10.** The `enable_capability(name)` tool returns a skill to `systemPromptOptions.skills` or an agent to the catalog and removes the name from the hidden section. If the capability is not installed or was not hidden, it returns an error.
- **R11.** There is no separate tool for built-in tools: `exposure: "deferred"` and `tool_search` are enough.
- **R12.** Re-enabled items are saved in the `capfilter` entry and do not disappear after the session is restored.

## Out of scope

- MCP: in `codemode`, MCP tool schemas do not enter the request anyway, and a cheap model call would cost more than it saves.
- A filter for subagents (COST-10).

## Compatibility

- Only `systemPromptOptions`, `sections`, and `selectedTools` change, not the whole `systemPrompt` ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)). The set changes only at a task boundary.
- References to Junie are collected in [junie-cost-savings.md](../../research/junie-cost-savings.md).

## Verification

Not implemented yet. Live tests are needed for the thresholds (R2), response parsing (R5), hidden sections (R7–R9), and re-enabling via `enable_capability` with session restore (R10, R12).

## Open questions

- Which Pi built-in tools count as rare.
- Where the custom agent catalog is stored until `spawn_subagent` appears (COST-10).
