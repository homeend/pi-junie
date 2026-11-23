---
id: COST-13
title: Bash timeout guidance
package: junie-cost
status: implemented
pi: 1.5.2
depends: []
code: [packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/bash-guidance.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-bash-timeout-guidance.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
---

# COST-13. Bash timeout guidance

## Goal

Give the model Junie's instruction to choose a realistic bash timeout rather than routinely choosing the maximum, and read an obvious millisecond timeout as milliseconds.

## Behavior

- **R1.** When `bash` is selected and its declaration is not hidden, junie-cost adds this guideline: "For `bash`, choose `timeout` greedily based on realistic estimates — do not use the maximum timeout as a default. Overestimating wastes session time needed for other commands. For orientation, Junie uses 60 seconds by default, 300 seconds for long-running commands, and a 20–3600 second range. These are reference values, not Pi defaults or enforced limits." The Junie source is recorded in the linked research.
- **R2.** The guideline is added through `before_agent_start` using `systemPromptOptions.promptGuidelines`. Its text is constant, independent of the task and model; it is not duplicated on subsequent prompts. Existing guidelines and other prompt data are preserved.
- **R3.** Without a declared `bash`, the extension adds no timeout guideline. It does not register or replace a tool, change tool schemas, or add a runtime timeout; the only argument it changes is the one in R5.
- **R4.** The guideline of R1 ends with the unit: "`timeout` is in seconds, not milliseconds: 300 means five minutes." Pi's schema already says "Timeout in seconds", yet in the eval run of 2026-11-18 models passed millisecond values (`10000`, `120000`, `300000`) about 1600 times, 138 of them for gradle, which Pi accepts as hours or days. Junie has no such sentence; it was added with the user's agreement.
- **R5.** Before a `bash` call runs (`tool_call`), a `timeout` above 3600, Junie's largest bash timeout, is taken for milliseconds and replaced with `ceil(timeout / 1000)` seconds; smaller values, including 1200 and 1800, are kept. In the eval run of 2026-11-20 the guideline of R4 did not reach Eco models (COST-06.R21), and 1389 of 3267 bash calls passed values above 3600: `10000`, `15000`, `120000`, also `5000` and `8000`, mostly on quick `ls`/`grep` commands, so 10 s is what the model meant. The assistant message keeps the original value; Pi's timeout message reports the converted seconds. Junie has no such conversion; it was added with the user's agreement.

## Out of scope

- Enforcing Junie's numeric defaults or bounds, command classification, and background execution rules. The numbers in R1 are guidance only; R5 converts units and does not clamp a value.
- Enforcing the instruction, retrying commands, or adding per-command reminders.
- New settings or commands.

## Compatibility

- Uses Pi 1.5.2's public `before_agent_start` and `promptGuidelines` API, not Pi internals or a whole-system-prompt replacement; see [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md). With an Eco pair the guideline is sent next to the Eco rule, which is a prompt section (COST-06.R21).
- R5 mutates `tool_call.input` in place, which Pi documents as the way to patch arguments before execution; later `tool_call` handlers of other extensions see the converted value.
- Pi renders `promptGuidelines` with its default structured prompt. Custom or forced system prompts are not overridden to insert the instruction.
- Pi's optional timeout remains optional, with no default timeout. [COST-02](../implemented/cost-02-tool-output-limits.md) continues to govern output processing without changing timeouts.
- A user who really wants a bash timeout of more than one hour cannot set it in seconds; such a value is read as milliseconds.

## Settings

None. The guideline is included when the extension is loaded and R1 applies.

## Verification

Live integration tests through real Pi with `jetbrains-ai/gpt-6-luna` inspect outgoing provider requests:

- R1, R2: the guideline is sent exactly once with bash enabled, stays identical across tool turns and a second prompt in the same session, and coexists with another extension's guideline.
- R3: no guideline with bash disabled; an explicit `timeout: 1` in a real bash call remains unchanged despite the reference range.
- R4: the sent guideline contains the unit sentence.
- R5: a real bash call `sleep 7; printf LATE` with `timeout: 5000` times out after 5 seconds, while the explicit `timeout: 1` of R3 stays unchanged.
- R2 on an Eco pair: with `grok-4.6-eco` and Pi's default prompt, the first request carries the guideline, another extension's guideline and the Eco rule (COST-06.R21).
- The tests log the agent run and the guideline in outgoing requests so the instruction is visible during review.

## Open questions

- None. The user agreed to Junie's numbers for orientation in the guideline and to the millisecond conversion of R5.