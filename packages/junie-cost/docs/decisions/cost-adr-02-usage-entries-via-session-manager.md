# COST-ADR-02. Auxiliary usage through Pi's `appendUsage`

Status: accepted

## Context

junie-cost makes its own cheap-model requests through `createSummarizationClient` (tool output summaries and compaction retellings, COST-14). Their cost has to reach Pi's accounting: `getSessionStats()` (`dist/core/agent-session.js:3552`), `getUsageCostBreakdown` (`dist/core/usage-totals.js:43`), Pi's footer (`dist/modes/interactive/components/footer.js:96-113`) and junie-ui's footer (`packages/junie-ui/src/footer.ts`). They count assistant messages, `toolResult.usage`, `type: usage` entries and the usage of compaction and branch summary entries; custom entries are not counted.

Pi 1.5.2 gives extensions two candidates:

- `usage` in the `tool_result` handler result (`ToolResultEventResult.usage`). Pi replaces the field rather than adding to it (`dist/core/extensions/runner.js:937-938`), and the result is stored before background summaries return, so most requests cannot be attached to it.
- `SessionManager.appendUsage(kind, provider, model, usage, note?)` (`dist/core/session-manager.d.ts:276`), which Pi uses for cache warming (`dist/core/cache-warmer.js:188`). The extension's `ctx.sessionManager` is typed `ReadonlySessionManager` without it, but at runtime it is the session's `SessionManager` (`dist/core/extensions/runner.js:642-644`).

## Decision

- Auxiliary requests are recorded with `ctx.sessionManager.appendUsage(kind, …)`, one entry per response, with a kind chosen by the caller (`tool_output_summary`, `compaction_summary`).
- The call is made inside the client (`src/summarization-client.ts`), right after `ctx.modelRegistry.complete` returns and before the response is checked. Rejected responses, responses that lose the deadline race and any future caller are recorded too, and a caller cannot forget it: `usageKind` is a required option.
- The compaction entry carries no `usage` of its own, so the retelling is not counted twice.
- The method is called only if it exists; a missing method or an exception means the usage is not recorded. The caller's work (the summary) never depends on it.
- No custom entry is written as a fallback: nothing in Pi or junie-ui counts it.
- The method is called, not wrapped, so there is no owner tag and nothing to remove on reload (invariant 2 is about wrappers); the guard is the presence check and the `try`.

## Consequences

- Pi's stats, cost breakdown and both footers include the requests without code in junie-ui; the entries are not sent to the model and do not touch the prompt cache.
- If Pi renames or removes `appendUsage`, the requests keep working and their cost silently disappears from the session; the COST-14 live tests catch it.
- When Pi gets a public API for extension usage, the call moves to it and this record is superseded.

## Where it applies

COST-14. COST-15 (Eco planning requests) gets the same accounting if it moves to the client.
