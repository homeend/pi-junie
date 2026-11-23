---
id: AI-02
title: Model catalog and request compatibility
package: jetbrains-ai
status: implemented
pi: 1.5.2
depends: [AI-01]
code: [packages/jetbrains-ai/src/models.ts, packages/jetbrains-ai/src/streams.ts, packages/jetbrains-ai/src/provider.ts]
tests: [packages/jetbrains-ai/test/provider.integration.test.ts]
research: []
manual: [R3, R4, R5, R6]
---

# AI-02. Model catalog and request compatibility

## Goal

`/model` shows the same JetBrains AI models as Junie, and requests to them go through Ingrazzio routes without the errors specific to individual models.

## Behavior

- **R1.** The `jetbrains-ai` provider catalog is a snapshot of 34 models from `ModelOption.Specific` in Junie. It includes deprecated models and the internal Qwen model. Each model specifies its protocol, context window, `maxTokens`, reasoning and image support, and prices.
- **R2.** Protocols are the built-in Pi ones: `openai-responses`, `openai-completions`, `anthropic-messages`, `google-generative-ai`. The extension has no protocol implementation of its own.
- **R3.** Google models go to `https://ingrazzio-cloud-prod.labs.jb.gg/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google`. Models with the `X-LLM-Model: jbai` header go to `https://ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1`. The rest use the `baseUrl` from the snapshot or from the provider.
- **R4.** For `gpt-5-2025-08-07`, `gpt-6-astra`, and `gpt-6.1-sol`, the value `reasoning.effort: "none"` is replaced with `"low"`: the route does not accept `none`.
- **R5.** Claude Opus 4.6–5.5, Sonnet 5 and 5.5, and Fable 5 and 5.1 get `thinking: { type: "adaptive" }` if `thinking` is unset or set to `enabled` or `disabled`. The exception is Sonnet 5.5: with `disabled` it gets `between_tools`.
- **R6.** The caller's `onPayload` runs before these edits: the edits do not overwrite payload changes made by Pi or other extensions.

## Out of scope

- Guaranteed access: a model may be in the catalog but unavailable to the account.
- Eco models with the `-eco` suffix: they are registered by junie-cost (COST-06), not by this package.
- Automatic catalog updates: the snapshot is updated manually by comparing with the Junie sources.

## Compatibility

Payload edits are made via the standard `StreamOptions.onPayload` and only for models from the R4–R5 lists; other requests go out unchanged.

## Verification

- The live test verifies R1 and R2 on the cheapest catalog model, `gpt-6-luna`: protocol `openai-responses`.
- R3–R6 are not covered by automated tests. They are verified manually by a request to a model of the corresponding family.

## Open questions

- Should an offline test for `jetbrainsStreams` (R4–R6) be added: it does not need network.
