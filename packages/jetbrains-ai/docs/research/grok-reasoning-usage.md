# Reasoning tokens of Grok models in Pi and Junie

Facts behind [AI-03](../specs/implemented/ai-03-reasoning-usage.md). Junie paths are relative to `~/Work/junie-agent-manual`, read at `origin/main` 29fd112803 (2026-11-20).

## Pi

- Over `openai-completions` Pi takes `completion_tokens` as `usage.output` and stores `completion_tokens_details.reasoning_tokens` separately in `usage.reasoning`, with the comment "OpenAI completion_tokens already includes reasoning_tokens" (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1187`). `totalTokens` and the price are computed without `reasoning`.
- Over `openai-responses` Pi takes `output_tokens`, which already include reasoning (`openai-responses-shared.js:512`).
- Pi's own xAI catalog sends `grok-4.3`…`grok-4.7` over `openai-responses`, with `off` and `minimal` mapped to `null` for 4.5–4.7 (`node_modules/@earendil-works/pi-ai/dist/providers/data/xai.json`).
- `xhigh` and `max` are offered only when `thinkingLevelMap` names them; `null` hides a level (`getSupportedThinkingLevels`, `pi-ai/dist/models.js:693`).

## The Grok route on Ingrazzio

Before AI-03 the catalog sent Grok over `openai-completions`. Live probes of `grok-4.6` on 2026-11-20/21:

| Probe | Usage reported | Note |
| --- | --- | --- |
| Pi, "Reply with exactly OK.", `--thinking off` | `output` 1, `reasoning` 26 | `totalTokens` = input + output + cache, without reasoning |
| Pi, interval-merge function, `--thinking medium` | `output` 393, `reasoning` 81 | 393 tokens match the 1356 visible text characters |
| raw `/v1/chat/completions` | `prompt` 218, `completion` 21, `reasoning` 266, `total` 505 | reasoning is outside `completion_tokens` |
| same, provider cost | `cost_in_usd_ticks` = $0.001966 | = (90 × 2 + 128 × 0.5 + (21 + 266) × 6) / 1e6: reasoning is billed as output |
| raw `/v1/responses` | `output_tokens` 287 | reasoning is inside the output |
| raw vLLM `Qwen/Qwen3.6-27B-FP8` chat completions | `completion` 578, `reasoning` 550 | reasoning is inside; Qwen is not affected |

So over chat completions Pi did not bill Grok's reasoning. After the switch to `openai-responses` (Pi, `grok-4.6`): `--thinking off` (before the level map) fails with 400 because the route rejects `reasoning.effort: "none"`; `low`, `medium` and `xhigh` work, a two-turn tool call works with cache reads, and every message has `usage.output` ≥ `usage.reasoning` with `cost.output` = `output` × $6 / 1M.

## Junie

- Junie picks the OpenAI API in `ModelParametersEx.kt` (`core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/ModelParametersEx.kt:16-21`): Chat Completions only with `preferOpenAIChatAPI == true`, otherwise Responses when the provider supports it. XAI supports both (`ModelParametersEx.kt:38`). Grok models are declared without `preferOpenAIChatAPI` (`ModelParameters.kt:305`, `DefaultModelRequirements.kt:289-318`), so Junie sends Grok over the Responses API, to `/v1/responses` (`core/llm/src/main/kotlin/com/intellij/ml/llm/matterhorn/core/llm/LLMAccess.kt:20`).
- Effort levels: `GROK_4_6` and `GROK_4_7` offer Low, Medium, High, XHigh (`core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/EffortLevel.kt:111-112`). `GROK_4_3` and `GROK_4_5` are not listed there but are in `LLM.knownModels` (`ModelParameters.kt:389-390`), so they get the `resolved in LLM.knownModels` fallback of `EffortLevel.kt`: Low, Medium, High. No Grok gets `None`.
- Its cost is `calcTokenCost` (`core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm/AISender.kt:117`): input, output, cached input and cache-creation tokens times the model prices; reasoning is part of the Responses output.

## Impact on the Pi eval

Pi run 8 (TeamCity build 7690821) reported $32.14. Grok-4.6 wrote about 990k characters of visible reasoning in its trajectories; at the probe ratio (81 tokens per 91 characters) that is at least 0.9M unbilled output tokens, about $5–8 at $6 per million. It is a lower bound: reasoning is also produced in steps that show no reasoning text.
