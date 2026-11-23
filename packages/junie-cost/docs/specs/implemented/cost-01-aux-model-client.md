---
id: COST-01
title: Cheap model client
package: junie-cost
status: implemented
pi: 1.5.2
depends: []
code: [packages/junie-cost/src/summarization-client.ts, packages/junie-cost/src/utils.ts, packages/junie-cost/src/model-mix/router.ts, packages/junie-cost/src/index.ts]
tests: [packages/junie-cost/test/output.integration.test.ts]
research: [packages/junie-cost/docs/research/junie-cost-savings.md, packages/junie-cost/docs/decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md]
manual: [R2, R3, R4, R5, R6, R7, R8, R9, R10]
---

# COST-01. Cheap model client

## Goal

A shared client through which extensions make auxiliary requests (output summaries, command recaps for compaction) to a cheap model of the same provider. The request does not touch the main model's cache and does not break the calling code if something goes wrong.

## Behavior

Model selection:

- **R1.** The model is selected only among available (`ctx.modelRegistry.getAvailable()`) models of the same provider as the main model `ctx.model`. Preference order by the main model's family:
  - OpenAI — `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.4-nano`;
  - Anthropic — `claude-haiku-5-5`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001`;
  - Google — `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-flash-lite`, `gemini-flash-lite-latest`.
- **R2.** If an Eco pair (COST-06) is selected, the virtual model is first replaced with a physical model of the `jetbrains-ai` provider: the first available of `gpt-6-luna`, `claude-haiku-5-5`, or the pair's main model. If none is available, the client returns `undefined`.
- **R3.** The family is determined by the provider (`openai`, `openai-codex`, `azure`, `anthropic`, `google`, `google-vertex`) or by the model id prefix. Gateway ids with a vendor prefix (`anthropic/claude-sonnet-4-6`) are recognized too, and the request stays on the gateway instead of moving to the direct provider.
- **R4.** The main model is used if the family is unknown or none of the cheap models in the list is available. Without a main model the client returns `undefined`. Selection is repeated on every call.

Request parameters:

- **R5.** The request goes through `ctx.modelRegistry.complete()` with `cacheRetention: "none"`, `temperature: 0`, and the lowest reasoning level from `thinkingLevelMap`. OpenAI-compatible models without a level map get `low`, Anthropic has thinking off, Google gets the minimal level if one is defined, otherwise thinking is off. No thinking token budget is passed.
- **R6.** `maxTokens` is 1024 by default and no more than the model's limit. `maxRetries: 0`: on error, no second paid request is made, neither to this model nor to another.
- **R7.** The caller must pass `timeoutMs`. One deadline covers model selection, authentication, and generation. On the deadline or on cancellation via `signal`, the request is aborted and the client returns `undefined`. With a non-positive or non-numeric `timeoutMs`, as with an already aborted `signal`, the request is not sent. Timers and abort handlers are removed.
- **R8.** An error, a cancellation, and a response with a `stopReason` other than `stop` (partial response, tool call) yield `undefined`. Client responses do not enter the session history.

API and diagnostics:

- **R9.** The module exports `createSummarizationClient(ctx)` with a single method `complete(context, options)`, as well as `selectSummarizationModel(ctx)` and the `SummarizationOptions` type. The exports are available from the package root and from `pi-extension-junie-cost/summarization-client`. `options.usageKind` is required: the client records the cost of every response in the session under that kind (COST-14).
- **R10.** The `/junie-cost` command shows `Summarization model: <provider>/<id>`, and without a model, the warning `No model selected.`. No LLM is called.

## Out of scope

- Price comparison and routing between providers: the preference order is set explicitly.
- Retries and a fallback model on error.
- A guarantee of zero cost on cancellation: aborting on the provider side is best effort.

## Compatibility

- Uses `ctx.model`, `ctx.modelRegistry.getAvailable()`, and `ctx.modelRegistry.complete()` (Pi 1.5.2). Pi internals are not patched. The only undeclared call is `ctx.sessionManager.appendUsage`, made only if the method exists ([COST-ADR-02](../../decisions/cost-adr-02-usage-entries-via-session-manager.md)).
- The client is created from the `ctx` of the current hook; an old context must not be kept between sessions.
- Own requests follow [COST-ADR-01](../../decisions/cost-adr-01-cache-safe-prompt-and-history-changes.md): no cache and minimal reasoning. If individual Junie specifications require higher effort, the plan's minimal-reasoning policy takes precedence.
- `ModelRegistry.complete` does not route virtual models, so the client maps the Eco model to a physical one itself (R2): it takes the Eco router's implementation models in the order the router uses for its own requests outside the agent loop (COST-06.R17).

## Settings

- The `/junie-cost` command — diagnostics (R10).

## Verification

- R1 is indirectly covered by the live test `output.integration.test.ts`: a real summary of a large bash output comes from the model selected by the client on the `jetbrains-ai` provider.
- R2–R10 are verified manually: live tests do not deterministically reproduce provider failures, cancellation races, and all model selection branches. The package has no mocked tests.

## Open questions

- Model ids were checked against the Pi 1.5.2 catalog in November 2026. A model's presence in the catalog does not guarantee access through the configured provider.
