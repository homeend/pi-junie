# AIR features ↔ Pi: plugin or bridge code

Every feature in Junie's AIR contract (`junie-agent/docs/acp-air-communication.md`, feature table), mapped to where
pi-junie gets the agent-side behaviour:

- **Pi core**: the SDK already does it; the bridge only maps it to ACP.
- **Pi plugin**: an existing pi package (`pi install npm:<name>`) does it; the bridge detects it (`src/pi/plugins.ts`),
  loads it, and maps its state/events to ACP (`src/compat/features.ts` advertises the AIR capability only when present).
- **Bridge**: nothing in Pi or its ecosystem fits; coded in pi-junie.

Plugin candidates were checked on npm on 2026-11-17 (version, weekly downloads). "Done" = implemented and checked in
AIR.

## Summary

| AIR feature | Source | pi-junie status |
|---|---|---|
| Initialize / client identity | Bridge (ACP driver) | Done |
| Auth status | Bridge | Done (`_auth/status_update`, JetBrains AI label) |
| Provider model discovery + provider config | Bridge (Pi core model runtime) | Done (proxy discovery, all providers incl. Vertex) |
| Session instructions | Pi core (`appendSystemPrompt`) | Not yet; trivial |
| Additional skill roots | Pi core (`additionalSkillPaths`) | Done |
| Session index / list / load / resume | Pi core (`SessionManager`) + bridge store | Done (list, load, resume, loadReplayEnd) |
| Session archive / rename / delete | Bridge (file level); Pi core has names | Not yet; archive has no Pi equivalent |
| Session fork | Pi core (`forkFrom`, branching) | Not yet; small |
| Steering | Pi core (`steer`) | Done (AIR does not send it yet) |
| Goal mode | **Plugin**: `@narumitw/pi-goal` or `pi-codex-goal` | Not yet; plugin + mapping |
| Plans / plan review / plan files | **Plugin**: todo list `@juicesharp/rpiv-todo`; plan mode `@narumitw/pi-plan-mode` | Todo list done (plan `main`); plan mode next |
| Permission requests | Bridge (Pi has no permissions) | Done |
| Brave mode (Safe / Auto / Brave) | Bridge (our gate); optional rules plugin `@gotgenes/pi-permission-system` | Done (Auto = rule-based read-only commands) |
| Elicitation forms | Bridge (`ask_user`, Junie's tool) | Done |
| Unattended interaction | — | AIR does not negotiate it; skip |
| Commands and skills | Pi core (skills, `/compact`) | Done |
| Native subagent sessions | **Plugin**: `@tintinweb/pi-subagents` | Done (foreground, parallel, chosen models) |
| Legacy subagent blocks | — | Not needed (AIR uses native sessions) |
| Terminal output | Bridge (bash tool → live terminal) | Done |
| Message phases | Bridge (Pi text signatures + heuristic) | Done |
| Skill and MCP tool presentation | Bridge | Done (MCP, IDE router) |
| Context compaction | Pi core (`compact`, `compaction_start/end`) | Partly (`/compact`); auto-compaction events not mapped |
| Typed session failures | Bridge | Done |
| Changed-file reports | Bridge (from edit/write/bash tool results) | Not yet |
| Prompt suggestions | Bridge (no usable plugin: the only ones are TUI ghost text) | Not yet |
| Usage and cost | Pi core (message usage, `getSessionStats`) | Done |

**Count**: of 25 features, 4 come from Pi plugins (subagents done; goal, plan/todo, optional permission rules), 9 are
Pi core with a bridge mapping, and the rest are protocol work the bridge must do anyway (ACP shapes, IDE proxy,
presentation). Plugins matter most for *agent behaviour* (subagents, goals, plans); most AIR features are
*presentation* of things Pi already does.

## Per feature

### Plugin-backed

- **Native subagent sessions**: `@tintinweb/pi-subagents` 0.26 (24k/wk). In-process children on the bridge's model
  runtime; the bridge adopts each child session, mirrors it to AIR's child session, gates its tools. Done.
- **Goal mode** (AIR: goal setup form → goal state/control, Brave Mode + cost cap in the setup form):
  - `@narumitw/pi-goal` 0.55 (10k/wk): custom entry `goal-state {goal}`, status
    `active|paused|blocked|usage_limited|budget_limited|complete`, run events on `pi.events`. Shares a mutex channel
    with `@narumitw/pi-plan-mode` and `@narumitw/pi-usage` (works best with them).
  - `pi-codex-goal` 0.7 (1.2k/wk): tools `get_goal`/`create_goal`/`update_goal`, entry `ThreadGoal{objective, status,
    tokenBudget, usage}`; Codex-shaped like AIR's goal.
  - Bridge: AIR's `goal` command + setup form → plugin's goal; goal state from the custom entry → AIR goal updates.
- **Plans** (AIR: `plan` session updates with entries/status, plan review via permission, plan file link):
  - Todo/plan entries: `@juicesharp/rpiv-todo` 2.15 (15.7k/wk), tool `todo` with
    `details.tasks: {id, subject, status: pending|in_progress|completed|deleted}[]`, almost 1:1 to ACP plan entries.
  - Plan mode (plan first, approve, then implement): `@narumitw/pi-plan-mode` 0.60 (10.4k/wk, markdown plan in a
    custom entry, `PLAN.md` export) or `@plannotator/pi-extension` 0.28 (21.7k/wk, browser approval UI; too much
    surface for AIR). Their plans are markdown, so entries must be parsed. Likely simpler: bridge plan mode
    (read-only tools + "submit plan" tool approved through AIR's plan review) with rpiv-todo for execution tracking.
- **Permission rules** (optional, for Brave "Auto"): `@gotgenes/pi-permission-system` 42 (9.6k/wk) allow/ask/deny per
  tool, bash pattern and path, `getPermissionsService(sessionId)`. Pi itself never asks; the bridge's gate is what asks
  AIR, so Brave mode is bridge code either way.

### Pi core, mapped by the bridge

Session list/load/resume, fork (`SessionManager.forkFrom`, branches), names, steering (`steer`/`followUp`), compaction
(`compact`, auto-compaction events `compaction_start{reason}`/`compaction_end`), usage and cost
(`getSessionStats`, message usage), session instructions and skill roots (resource-loader options,
`before_agent_start`).

### Bridge only

ACP driver and AIR metadata, provider discovery through AIR's proxy, auth status, permissions + Brave mode,
elicitation (`ask_user`), terminal output, phases, typed failures, changed-file reports (edit/write diffs + bash, no
usable plugin: `pi-diff-widget` is TUI-only), prompt suggestions (only TUI ghost-text plugins exist), session
archive/delete (file level).

## Prior art

`pi-acp` (508k/wk) runs `pi --mode rpc` as a subprocess and maps compaction, steering and context usage to ACP; it has
no plans, goals, todos or subagents. Our tool-presentation code is ported from it.
