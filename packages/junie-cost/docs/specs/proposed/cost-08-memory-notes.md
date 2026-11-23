---
id: COST-08
title: Memory notes
package: junie-cost
status: proposed
pi: 1.5.2
depends: [COST-03]
code: []
tests: []
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-08. Memory notes

## Goal

The model's findings must survive history thinning (COST-03). Thinning replaces only the content of tool results, and the assistant text remains. So a note is a regular text block in the response, and no separate tool is needed.

## Behavior

- **R1.** A rule is added to `sections`: before a tool call, when asked, write a `<UPDATE><PREVIOUS_STEP>…</PREVIOUS_STEP></UPDATE>` block with key findings, no more than three sentences. Wording: "Chat history might be truncated, so these updates are the only record of previous steps".
- **R2.** The block is not required in every response. If it is absent from the last 4 assistant responses (3 for DeepSeek and Qwen thinking), the request "be very brief, three sentences maximum" is appended to the last tool result in `tool_result`. For models with weak reasoning, the request is "only essential findings".
- **R3.** The request is appended to the tool result. It is not added as a separate message or to the system prompt.
- **R4.** For models with adaptive thinking or with reasoning summary output, the block is not required: the reasoning stays in the history anyway. The list of such models is set in the extension configuration.

## Out of scope

- A separate tool for notes or storage outside the history.
- Compression of assistant text.

## Compatibility

- The rule is a separate `sections` section. The variable request is appended to the tool result, not to the prompt ([COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md)).
- Changing the result in `tool_result` must work together with the COST-02 limits.
- The Junie reference (`PlanUtil.nextResponseWarning`) is in [junie-cost-savings.md](../../research/junie-cost-savings.md).

## Settings

- The list of models for which the block is not required (R4). The key is not defined yet.

## Verification

Not implemented yet. R2 and R3 — a test for the request in the tool result after 4 responses without the block. R4 — a test with a model from the exclusion list.

## Open questions

- How to identify models "with weak reasoning" in Pi.
