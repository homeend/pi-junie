---
id: AI-03
title: Reasoning tokens in the usage and cost of Grok models
package: jetbrains-ai
status: implemented
pi: 1.5.2
depends: [AI-02]
code: [packages/jetbrains-ai/src/models.ts]
tests: [packages/jetbrains-ai/test/provider.integration.test.ts]
research: [packages/jetbrains-ai/docs/research/grok-reasoning-usage.md]
manual: [R3, R4]
---

# AI-03. Reasoning tokens in the usage and cost of Grok models

## Goal

The usage and the price that Pi records for a `grok-*` response include the reasoning tokens the provider bills for. Before this spec the catalog sent Grok over `openai-completions`: the Ingrazzio Grok route reports reasoning outside `completion_tokens`, Pi assumes it is inside, so every Grok request was undercounted in the session, the footer and the eval harness (`usage.cost.total`) — about $5–8 on the $32.14 of Pi eval run 8. Junie sends Grok over the Responses API, where reasoning is part of `output_tokens`. Details and probes: [grok-reasoning-usage.md](../../research/grok-reasoning-usage.md).

## Behavior

- **R1.** `grok-4.3`, `grok-4.5`, `grok-4.6` and `grok-4.7` use Pi's built-in `openai-responses` protocol, with the same base URL and `X-LLM-Model: grok` header as before, as Junie does. Their final assistant message has `usage.output` that includes the reasoning tokens (`usage.output` ≥ `usage.reasoning`), and `usage.cost` is Pi's usual price of that usage; the extension does not correct usage itself.
- **R2.** Thinking levels follow Junie: `grok-4.6` and `grok-4.7` offer `low`, `medium`, `high`, `xhigh`; `grok-4.3` and `grok-4.5` offer `low`, `medium`, `high`. `off` and `minimal` are not offered: the route rejects `reasoning.effort: "none"`, and Pi clamps a requested `off` to `low`.
- **R3.** Eco models (`grok-4.6-eco`, `grok-4.7-eco`, COST-06) route to the physical models of this provider and get the same usage.
- **R4.** Other models are not changed: Qwen on the vLLM route already includes reasoning in `completion_tokens` and stays on `openai-completions`.

## Out of scope

- Prices of the catalog: they stay as in Junie (`models.ts`).
- A usage correction for `openai-completions`: not needed once Grok uses the Responses API.
- Usage of auxiliary LLM calls made by junie-cost (COST-14).
- The eval harness: it reads `usage.cost.total` from the session and needs no change.

## Compatibility

- Only catalog data changes (`api`, `thinkingLevelMap`); no payload hooks, so the prompt cache and other extensions' `onPayload` are unaffected.
- With `off` no longer offered, a Grok session started with `--thinking off` runs at `low`. Grok reasoned at `off` before as well (26 reasoning tokens for "OK").
- Pi's own `xai` provider also sends `grok-4.x` over `openai-responses` without `off` and `minimal`.

## Settings

None.

## Verification

- Live test in `packages/jetbrains-ai/test/provider.integration.test.ts`: one request to `jetbrains-ai/grok-4.6` with `--thinking off` and a prompt that makes the model reason; the assistant message has protocol `openai-responses` and stops normally (`off` is clamped instead of failing with 400), `usage.output` ≥ `usage.reasoning` > 0 and `usage.cost.output` = `usage.output` × 6 / 1e6 (R1, R2).
- R3 is verified manually: a request through `jetbrains-ai/grok-4.6-eco` with junie-cost loaded.
- R4 is verified manually: the catalog diff touches only the four Grok entries; the vLLM probe is in the research.

## Open questions

None.
