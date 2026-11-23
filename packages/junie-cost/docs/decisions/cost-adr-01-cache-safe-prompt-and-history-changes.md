# COST-ADR-01. Prompt and history changes without resetting the cache

Status: accepted

## Context

Pi caches the request prefix: the system prompt, tools, and history. Rewriting the system prompt or the beginning of the history resets the cache, and the next request is billed at full price. The junie-cost extension saves tokens, so its own changes must not reset the cache at a cost higher than the savings gained. A short digest of these rules, mandatory for all packages, is invariant 3 in [`AGENTS.md`](../../../../AGENTS.md); this document explains where they come from. How this works in Junie is described in [research/junie-cost-savings.md](../research/junie-cost-savings.md#common-rules-cache).

## Decision

- The system prompt changes only through `sections`, `selectedTools`, and `promptGuidelines`. `before_agent_start` must not return the whole `systemPrompt`.
- History is changed only by persistent `context_edit` entries, not by the `context` hook: the hook does not affect the auto-compaction counter and collapses the prompt into a single system message.
- The extension's own LLM calls run with `cacheRetention: "none"` and minimal reasoning.
- The date, the capability list, and other volatile data are passed in a separate message, not in the system prompt.
- Exposure of MCP servers and tools does not change: by default Pi exposes them as `codemode`, and the user enables `direct` themselves, deliberately.
- One change — one commit. Parts of a change on their own are either useless, break the cache, or hide capabilities with no way to bring them back, so they are merged together.

## Consequences

- Every prompt or history change in junie-cost must be checked for cache preservation. History thinning (COST-03) runs only when the savings exceed the cost of re-caching.
- `context_edit` entries are stored in the session, so thinning is not repeated after the session is restored.
- A model switch (Eco mode, COST-06) resets the cache anyway, so the model is switched at most once per task.
- Auxiliary calls do not warm the cache and are cheap. If a call fails, the extension continues as if it never happened.

## Where it applies

COST-01–COST-11. Where Eco mode deviates from these rules is described in the "Compatibility" section of spec [COST-06](../specs/implemented/cost-06-eco-mode.md).
