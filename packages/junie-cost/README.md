# Junie Cost

> **This is a copy.** It was taken on 2026-11-23 from `pi-extension-junie-cost` 0.1.0 in the junie-pi repository
> (`packages/junie-cost`), so that pi-junie can change it. It is loaded into every pi-junie session by the bridge
> (`packages/bridge`, `PI_AIR_JUNIE_COST=0` leaves it out), not installed with `pi install`.
>
> Changes in this copy:
> - Eco routing (`src/model-mix/router.ts`): the route of a request is decided from its own conversation, not from the
>   planner's state, because pi-junie's sessions share one model runtime (an extension's virtual models live there,
>   so the router saw only the session that registered last). Pairs are provider-neutral: a runner registers Eco
>   models of its own providers under the `eco` provider (`registerEcoTarget`), with any primary and implementation
>   model; the registry lives on `globalThis`, since the runner's import and Pi's extension loader make two instances
>   of the module. An Eco target may name the implementation model's thinking level (the account's
>   `ECO_MODE_IMPLEMENTATION` effort). Tests: `test/router.test.ts`.
> - package name `pi-junie-cost`, private; the live integration tests (`test/*.integration.test.ts`, which need
>   junie-pi's `jetbrains-ai` package and model quota) are not copied, the bridge tests it offline
>   (`packages/bridge/test/junie-cost.test.ts`).
>
> The text below is the original README.

Junie-inspired cost optimizations for Pi:

- a shared cheap-model client for auxiliary requests;
- tool-output limits and summaries;
- cache-aware history thinning;
- a task journal with a code-built compaction summary;
- Eco mode (Junie's Model Mix);
- Junie's benchmark rules for eval runs;
- bash timeout guidance with Junie's reference values (not enforced limits); a timeout above one hour is read as milliseconds.

Capability filtering is not implemented yet.

Detailed behavior, Pi compatibility notes and Junie references are in the specs: [docs/specs/](docs/specs/) (in Russian).

## Install

Requires Node.js 22.19.0+ and Pi with `modelRegistry.complete()` (developed and tested with Pi 1.5.2).

From the repository root:

```sh
pi install ./packages/junie-cost
```

Or load for one session:

```sh
pi -e ./packages/junie-cost
```

Everything except Eco mode is on by default. The extension never switches the selected session model, never starts a compaction itself, and keeps original messages intact in the session file and UI.

## Eco mode

Eco mode is Junie's Model Mix: the selected strong model plans, a cheaper model implements. Select an Eco pair such as **`jetbrains-ai/claude-opus-5-5-eco`** in Pi's model picker (or with `--model`). Pairs exist for the models for which Junie's picker offers Eco:

`claude-fable-5-1`, `claude-fable-5-2`, `claude-opus-5`, `claude-opus-5-5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `grok-4.6`, `grok-4.7`.

As in Junie, Opus 5.5 is not offered at `low` effort and GPT-6.1 Terra starts at `medium`. A pair needs an authenticated `jetbrains-ai` provider ([jetbrains-ai](../jetbrains-ai)); if its primary model is missing from the catalog, the first request fails with an explicit error.

1. A new task runs on the pair's primary model at the selected thinking level.
2. For code changes the agent calls `create_plan` and plans in the same session. During planning, editing existing files is blocked; creating a new repro test or script is allowed. `report_plan` ends planning. The transcript shows `Planning…` and then `● <one-sentence summary>`; expand the row (ctrl+o) to see the full plan.
3. Implementation runs on `jetbrains-ai/gpt-6-luna` with `high` reasoning, falling back to `claude-haiku-5-5`, or to the primary model if neither is available. After three consecutive failed implementation turns, one request goes back to the primary model.

The session model stays the Eco pair; the footer and assistant messages show the physical model of each request. If you pass an explicit `--tools` allowlist, include both `create_plan` and `report_plan` for planning to work. With a regular (non-Eco) model, both tools stay hidden.

## Commands

| Command | Effect |
| --- | --- |
| `/junie-cost` | Shows the selected summarization model without making an LLM request |
| `/compact` | Pi's manual compaction; this extension replaces its summary with a hard summary of recent tasks, without a model call |

## What changes for you

| Area | Behavior |
| --- | --- |
| `read` without `limit` | 100 lines initially, 300 lines when `offset > 1`; an explicit `limit`/`offset` is respected |
| `bash` timeout | Prompt guidance to choose a realistic timeout in seconds (not milliseconds): Junie's reference values are 60 s normally, 300 s for long-running commands, and a 20–3600 s range. These are not Pi defaults or enforced limits. A `timeout` above 3600 is taken for milliseconds and converted to seconds (`120000` → 120 s) |
| `bash` output | At most 200 lines / 10,000 characters (first and last 10 lines kept); over 10,000 characters a cheap model writes a 3–4-sentence summary within 5 s, followed by a preview |
| Built-in `grep`, `find`, `ls` (when enabled) | First 100 lines, 500 characters per line |
| A tool named `diff` | 1,000 lines, 100,000 characters |
| Shortened results | Link to the full output, kept outside the working tree: in `<session>.outputs/` next to the session file (stays with the session), or in a private temp directory deleted when the run settles for `--no-session` |
| Cost of cheap-model requests | Each request is recorded in the session as a Pi `usage` entry (kind `tool_output_summary` or `compaction_summary`) with its model, tokens and price, so `/session` and the footer include it; it is not sent to the model |
| Long sessions | Old tool results are replaced with one-line summaries or placeholders only when that is cheaper than re-caching the prompt |
| Compaction between tasks | Summary is built from the task journal instead of by the main model; at most one cheap-model request for command retellings |

Auxiliary requests stay on the primary model's provider and prefer `gpt-6-luna`, `claude-haiku-5-5` or `gemini-3.5-flash-lite` (and older budget models); otherwise they use the primary model. They are sent without prompt caching and with minimal reasoning.

## Configuration

There are no extension-specific settings. The only environment variable is `JUNIE_BENCHMARK_RULES`, set by eval pipelines as for Junie: when it is non-blank, its trimmed text is appended after a blank line to the text of every new prompt (not to steering or follow-up messages, slash commands or messages from other extensions), unless the prompt already contains it. The system prompt is not changed.

Otherwise the extension follows Pi's own configuration:

- the selected model and provider determine the auxiliary model;
- Pi's compaction settings (`compaction.enabled`, `compaction.reserveTokens`, `compaction.keepRecentTokens` in `settings.json`) decide when compaction happens;
- an explicit `--tools` allowlist must include `create_plan` and `report_plan` for Eco planning.

Other extensions that also replace the compaction summary in `session_before_compact` are incompatible.

## Shared client API

Other extensions can reuse the cheap-model client. Create it from the current hook's `ctx`:

```ts
import { createSummarizationClient } from "pi-extension-junie-cost/summarization-client";

const client = createSummarizationClient(ctx);
const response = await client.complete({
	systemPrompt: "Summarize the output in one factual sentence.",
	messages: [{ role: "user", content: output, timestamp: Date.now() }],
}, { timeoutMs: 5000, maxTokens: 256, signal, usageKind: "my_extension_summary" });

if (response === undefined) {
	// Keep the original output or use deterministic truncation.
}
```

`timeoutMs` and `usageKind` are required. The cost of every response, including rejected and late ones, is recorded in the session as a Pi `usage` entry of that kind. Errors, timeouts, cancellations and incomplete responses return `undefined`. `selectSummarizationModel(ctx)` returns the model without making a request.

## Development

From the repository root:

```sh
npm run check --workspace pi-extension-junie-cost
npm run test --workspace pi-extension-junie-cost
npm pack --workspace pi-extension-junie-cost --dry-run --ignore-scripts
```

The tests in `test/*.integration.test.ts` run the real `pi` CLI (on `PATH`) with `jetbrains-ai` and `junie-cost` loaded. They need network access and `JUNIE_API_KEY`, either in the repository-root `.env` or exported. They make live model requests and consume quota; nothing is mocked. Test titles start with the spec requirements they verify, for example `COST-02.R8`.
