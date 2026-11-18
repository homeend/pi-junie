# pi-junie: approach, findings and outlook

How Pi (the pi coding agent) came to run inside JetBrains AIR the way Junie does: what we assumed at the start, how we
found out what was actually needed, what we built, and what to expect next. Details live in [spec.md](spec.md)
(design and wire contract), [air-pi-feature-map.md](air-pi-feature-map.md) (feature-by-feature mapping),
[gap-analysis.md](gap-analysis.md) and [junie-proxy-triage.md](junie-proxy-triage.md).

## 1. In one paragraph

AIR can now start Pi as an ACP agent from `~/.jetbrains/acp.json`. The user can pick models from AIR's JetBrains AI
proxy, including Junie's Default group (Lite / Normal / Hard / Frontier) and the free Junie Lite model, and get a
full coding-agent session in AIR's UI. That covers tool cards with permissions and Brave Mode, a live terminal,
questions, subagents as native child sessions, the todo list in AIR's dock, plan mode with Junie's plan review, web
search and fetch, MCP servers, skills, slash commands, steering, chat history, titles and usage. Pi itself is not
modified. A bridge process embeds Pi's SDK and translates between Pi and ACP, and AIR features that need agent
behaviour Pi lacks come from existing Pi plugins the user installs with `pi install`.

## 2. Starting assumptions and what became of them

The original brief, in short, with the result next to it:

| # | Assumption at the start | What we found / did |
|---|---|---|
| 1 | Build a **Pi extension** that adds ACP to Pi. | AIR starts an agent as its own process and talks ACP over stdio. A Pi extension lives inside Pi's own (TUI) process. So the result is a **standalone ACP agent that embeds Pi's SDK in-process** (`@earendil-works/pi-coding-agent` 1.5.2). Pi's extension system is still used, for the bridge's own hooks (permission gate, `ask_user`) and for third-party plugins. |
| 2 | Use **ACP v2**. | AIR and Junie talk **v1** in every recording, so we matched v1. Version-specific shapes are confined to the codec, so v2 can be added there later. |
| 3 | **Bridge architecture**, like the Obsidian ACP client: ACP on one side, Pi on the other, no leaking. | Kept as stated and enforced by a test (`test/architecture.test.ts`): `src/acp` (driver) and `src/pi` (bridge) never import each other. They meet only through neutral types and ports in `src/core`. See §3. |
| 4 | Develop against a **simulator** built from recorded Junie ↔ AIR traffic, for fast, stable development. | Kept. Recordings are trimmed into fixtures (`scripts/extract-fixture.ts`, `test/fixtures/`) and replayed through the driver. A fake AIR proxy (`test/fake-proxy.ts`) plays the model, and stand-in plugins are written into a temp Pi agent dir. 130 tests run in about 2 s. |
| 5 | Junie offers a **fixed set of provider slots**, and AIR fills in each slot's models. Do the same. | Correct. AIR binds its proxy to each slot with `providers/set`, and the agent publishes the models as a grouped `model` option. We also adopted Junie's picker policy (only the models Junie's picker offers). Later we found the extra `ingrazzio` slot Junie asks for (§5). |
| 6 | First milestone: list AIR's models and **chat without tools**. | Reached on day one, then extended step by step into a full coding agent, one AIR feature per commit. |
| 7 | A **compatibility layer** mapping AIR features to Pi plugins, in both directions: a feature is advertised only when the plugins behind it are installed, and installed plugins unlock features. | Built (`src/compat/features.ts` for AIR capability flags, `src/pi/plugins.ts` for detection and per-plugin tools). The investigation showed the layer matters less than expected: most AIR features are presentation the bridge must do anyway, and only a few need agent behaviour from a plugin (§4). |
| 8 | Use AIR's `_meta` extension list (`junie-agent/docs/acp-air-communication.md`) as clues, without implementing everything. | It served as the feature checklist. The wire recordings and AIR's own source code (read-only) settled each detail. |

## 3. Architecture: the bridge

```
AIR ── stdio, JSON-RPC (ACP v1) ──► src/acp   ACP driver: framing, wire types, codec, method dispatch
                                       │       (knows ACP and AIR's _meta, knows nothing about Pi)
                                       ▼
                                    src/core  neutral types + ports: ProviderBinding, ModelGroup, TurnEvent,
                                       ▲       PlanUpdate, PermissionAsk, AgentBackend, BackendSession ...
                                       │
                                    src/pi    Pi bridge: Pi SDK sessions, model runtime, transcript -> TurnEvents,
                                               permission gate, plugin adapters (knows Pi, knows nothing about ACP)
                                    src/compat AIR feature <-> plugin requirement registry
```

- **The driver** turns ACP into core calls and core events into ACP `session/update`s. AIR's `_meta` contract lives
  only there: phases, plan cards, the Default group, command actions.
- **The bridge** runs one Pi `AgentSession` per chat. It turns Pi's event stream into neutral `TurnEvent`s (text,
  thoughts, tool updates, plans, questions) and decides permissions.
- **Plugin adapters** sit in the bridge, one small module per plugin (`subagents.ts`, `todo.ts`, `plan-mode.ts`,
  `web-access.ts`). Each knows that plugin's tools, state entries and quirks, and maps them to neutral events.
- **No client assumptions.** The client is whatever ACP `initialize` says it is. AIR-specific output is gated on
  negotiated capabilities (e.g. `clientCapabilities.plan`), and the model-facing text names the client as it
  introduced itself.

## 4. Mapping AIR features to Pi: core, plugin or bridge

Every feature in Junie's AIR contract was sorted into one of three sources (full table:
[air-pi-feature-map.md](air-pi-feature-map.md)):

- **Pi core**: the SDK already does it, and the bridge maps it to ACP. Sessions, resume, compaction, steering,
  usage and cost, skills, context files.
- **Pi plugin**: an existing package from the Pi ecosystem provides the agent behaviour, and the bridge adapts it.
- **Bridge**: nothing in Pi fits, so pi-junie implements it. Permissions and Brave Mode, `ask_user` elicitation,
  terminal output, message phases, typed failures, auth status, provider discovery through AIR's proxy.

**Result: of 25 AIR features, about 4 need a plugin. Most of the work is presentation.** The plugins in use, all
found on npm, read before use (downloaded code is treated as untrusted) and tested against the real package:

| AIR feature | Pi plugin | How the bridge adapts it |
|---|---|---|
| Native subagent sessions | `@tintinweb/pi-subagents` 0.26 | Adopts each child Pi session, mirrors it to AIR's child session, and gates the child's tools through the parent's permissions. |
| Todo list (AIR's Todo dock) | `@juicesharp/rpiv-todo` 2.15 | Each `todo` result becomes Junie's `plan_update` items (`id "main"`) instead of a tool card, and is replayed when a chat is reopened. |
| Plan mode + plan review | `@narumitw/pi-plan-mode` 0.60 | Junie's `mode` option and `/plan` toggle drive the plugin's commands. The finished plan becomes a Markdown plan card, and Junie's review (implement / revise / stop) goes through `session/request_permission`. |
| Web search and fetch | `pi-web-access` 0.48 | Tools enabled without the plugin's loader and shown as `search`/`fetch` cards. Searching runs without asking; fetching asks in Safe mode. |

Plugins we checked and set aside: goal mode (`@narumitw/pi-goal`, `pi-codex-goal`; postponed by choice), token and
cost dashboards, diff widgets and prompt-suggestion plugins (all need Pi's terminal UI, which an ACP session lacks).

**How a plugin is "checked"**, every time:
1. `npm pack` it into a temp dir and read its source: the tools it registers and their result `details`, the
   session state it saves, its config and keys, and any network or file side effects.
2. Work out how it behaves without Pi's TUI (`ctx.hasUI` is false in bridge sessions).
3. Write a small stand-in plugin with the same contract for fast tests, plus an optional test against the real
   package.
4. Map its state to the AIR shape found in AIR's source, then test in AIR.

## 5. What the investigation uncovered

Facts that changed the design, each found by reading recordings, AIR's or Junie's source, or our own logs:

- **AIR's proxy is the only gateway.** Every `providers/set` route is a local AIR URL plus a proxy key. The bridge
  never holds JetBrains credentials, and Pi's required API key is a placeholder stripped before requests leave.
- **The `ingrazzio` slot.** Junie lists an extra provider slot, and AIR answers it with a route to JetBrains'
  Ingrazzio API. Junie sends all its model traffic through it and reads the account's feature flags there.
  pi-junie now asks for it too. That made two things possible:
  - **Junie's Default model group**: the `JUNIE_MIXES` flag holds Lite / Normal / Hard / Frontier, each a model and
    an effort. It is shown with AIR's `defaultGroup` meta, so AIR shows the same slider as for Junie.
  - **Junie Lite**: Qwen3.6 27B, called through Ingrazzio's vLLM path with the free-license headers, at no cost.
- **AIR UI contracts that aren't obvious from the protocol:**
  - AIR turns the `/plan` command into a config toggle, so text typed after `/plan` never reaches the agent.
  - The Todo dock counts only completed items and keys rows by position.
  - A review attaches to a plan card only when `rawInput.plan` equals the card's Markdown.
  - AIR re-applies the user's saved model, effort and Brave Mode when a chat opens, and warns about whatever the
    agent didn't apply.
- **Where Junie's extras come from.** Junie's YouTrack and GitHub MCP servers come from Junie's own
  `~/.junie/mcp/mcp.json`, not from AIR. AIR passes the user's servers from `~/.jetbrains/mcp/mcp.json` to an agent
  only if its `acp.json` entry allows custom MCP servers (`use_custom_mcp`).
- **Plugin quirks the bridge has to absorb:**
  - Plugin commands start agent runs without awaiting them (`sendUserMessage`), so the bridge waits for those runs
    itself.
  - Pi's tool allowlist hides plugin tools unless they are listed.
  - `pi-web-access` can start a run of its own after a background fetch. The bridge turns that option off.

## 6. How development worked

- **The loop for each feature:**
  1. Read the recorded Junie ↔ AIR traffic and AIR's handling code.
  2. Write a replay or fake-proxy test.
  3. Implement in the driver and/or bridge.
  4. Run the full suite and the typecheck, then commit.
  5. The user tests the commit in AIR and sends screenshots and log excerpts.
  6. Fix from the log (`.pi-dev/pi-air.log` records every ACP request, model call and tool call).
- **Research before code.** For each plugin or AIR feature, a written proposal and explicit questions came first,
  and the user chose (e.g. which plan-mode plugin, the permission policy for web tools, Eco off for now).
- **Ground truth over documentation.** When the AIR `_meta` doc, the recordings and AIR's code disagreed, AIR's code
  won, since that is what renders the UI.
- **Size**: about 50 commits over two days, about 5,000 lines of source, about 2,800 lines of tests (130 tests plus
  one optional real-plugin test).

## 7. Where it stands

Working and checked in AIR: model discovery and picker (including the Default group and Junie Lite), chat, tools
with permissions and Brave Mode, terminal, MCP, skills and commands, `ask_user`, steering, subagents, todo dock, plan
mode with review, web access, chat list, resume and replay, titles, usage, typed failures.

Known gaps and limitations:
- **Eco** is reported off: Pi runs a Default level on its model and effort only.
- **Missing:** plan file links, goal mode, changed-file reports, prompt suggestions, session fork, archive and
  rename.
- **Plan-mode limits:** in plan mode the plan-mode plugin blocks MCP and web tools until its `defaultPlanTools`
  setting lists them.
- **Compat registry** (`src/compat/features.ts`): only the subagents flag is advertised; the other entries are
  placeholders that still need updating.
- **Packaging:** runs from a clone with Node 22.19+ (macOS and Linux launcher). The README is out of date.

## 8. What can be gained next, and what to expect

**Near-term gains, each a small, contained step:**
- **Real Eco:** the level's model plans, and the cheaper `ECO_MODE_IMPLEMENTATION` model (currently `gpt-6-luna`)
  implements through a subagent. This would make Normal, Hard and Frontier cheaper the way Junie's are.
- **Web search through Ingrazzio,** as Junie does (`IngrazzioWebSearchProvider`), instead of the plugin's default
  third-party search.
- **Plan files, changed-file reports, session fork,** and the plan-mode tool allowlist.
- **Sharing:** an install script and an updated README, so colleagues can clone, `npm ci` and register the agent.

**Longer-term value:**
- **A second agent in AIR with AIR's full UI:** Pi's open plugin ecosystem and quick model support, while the user
  keeps AIR's picker, cards, plans and subagents.
- **A reference for adding any ACP agent to AIR.** The driver, the core ports and the `_meta` knowledge are
  agent-neutral. Another agent would need a new bridge, not a new driver.
- **A living, tested description of AIR's agent contract,** useful when that contract changes or for the move to
  ACP v2.

**Realistic expectations and risks:**
- **Presentation parity with Junie is achievable** and mostly done. Agent quality depends on Pi and the chosen
  model, not on the bridge.
- **Internal JetBrains contracts can change without notice:**
  - Ingrazzio routes, the feature-flag schema, the free-license headers, and AIR's `_meta` keys are internal and
    mirrored from Junie. Most are versioned (`jetbrains.air.version`, `schemaVersion`), and the bridge falls back
    to plain behaviour when they're missing.
  - Check with the AIR or Junie team before using it beyond the company.
- **Third-party plugins change.** The bridge pins its expectations to a plugin's contract (tool names, `details`
  shape, state entries), and real-plugin tests catch breaking changes. Plugin updates should still be tried before
  rolling them out.
- **Maintenance follows Pi's SDK releases** (currently 1.5.2) and AIR's releases. The replay tests and the AIR log
  make both cheap to check.
