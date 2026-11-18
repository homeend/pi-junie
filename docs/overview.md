# pi-junie: Pi in JetBrains AIR

The approach, the original assumptions, what we found and how, what was built, and what to expect next.

---

## 1. Summary

AIR can now start **Pi** (the open-source pi coding agent) as an ACP agent, next to Junie. The user picks a model
from AIR's JetBrains AI proxy, including Junie's **Default group** (Lite / Normal / Hard / Frontier) and the free
**Junie Lite** model, and gets a full coding-agent session in AIR's UI:
- tool cards with permissions and Brave Mode
- a live terminal and questions to the user
- subagents as native child sessions
- the todo list in AIR's dock and plan mode with Junie's plan review
- web search and fetch, MCP servers, skills and slash commands
- steering, chat history, titles and usage

**Pi itself is not modified.** A bridge process embeds Pi's SDK and translates between Pi and ACP. AIR features that
need agent behaviour Pi doesn't have come from existing Pi plugins, which the user installs with `pi install`.

---

## 2. Background: the pieces involved

- **AIR**: the JetBrains AI client in the IDE. It starts agents as separate processes, listed in
  `~/.jetbrains/acp.json`, and talks to them over stdio.
- **ACP** (Agent Client Protocol): JSON-RPC between a client (AIR) and an agent (Junie, Pi). AIR extends it with
  JetBrains-specific `_meta` fields (`_meta.jetbrains.air.*`) for things plain ACP has no shape for: plan cards, the
  Default model group, message phases, auth status and more.
- **Junie**: JetBrains' agent and the reference implementation. Every behaviour we needed was first observed in
  recorded Junie ↔ AIR traffic.
- **Pi**: an open, extensible coding agent with an SDK (`@earendil-works/pi-coding-agent` 1.5.2), an extension API
  and an npm-based plugin ecosystem.
- **AIR's LLM proxy**: AIR never hands credentials to an agent. It gives the agent local proxy URLs plus a proxy key,
  and injects the user's JetBrains AI (or BYOK) credentials upstream.

---

## 3. Original assumptions and what became of them

| # | Assumption at the start | Result |
|---|---|---|
| 1 | Build a **Pi extension** that teaches Pi ACP. | AIR starts an agent as its own process, while a Pi extension lives inside Pi's own terminal process. So the result is a **standalone ACP agent that embeds Pi's SDK in-process**. Pi's extension system is still used, for the bridge's own hooks (permission gate, `ask_user` tool) and for third-party plugins. |
| 2 | Use **ACP v2**. | AIR and Junie talk **v1** in every recording, so we matched v1. All version-specific shapes sit in one codec module, so v2 can be added there. |
| 3 | **Bridge architecture**, as in the Obsidian ACP client: ACP on one side, Pi on the other, nothing leaking across. | Kept exactly, and enforced by an automated test (§4). |
| 4 | Develop against a **simulator** built from recorded Junie ↔ AIR traffic, to move fast and stay stable. | Kept. Recordings are trimmed into fixtures and replayed through the agent. A fake AIR proxy plays the LLM, and stand-in plugins mimic real ones. 130 tests run in about 2 seconds. |
| 5 | Like Junie, offer a **fixed set of provider slots**, and let AIR configure each slot's models. | Correct. AIR binds its proxy to each slot, and the agent publishes the models it can reach. We also adopted Junie's picker policy. Later we found the extra `ingrazzio` slot that Junie asks for (§7). |
| 6 | First milestone: list AIR's models and **chat without tools**. | Reached first, then extended step by step into a full coding agent, one AIR feature per commit. |
| 7 | A **compatibility layer** mapping AIR features to Pi plugins in both directions: a feature is offered only if its plugins are installed, and installed plugins unlock features. | Built. The investigation showed it matters less than expected: of 25 AIR features, only about 4 need a plugin, and the rest is presentation the bridge has to do anyway (§6). |
| 8 | Use AIR's `_meta` extension list as clues, not as a must-implement list. | It served as the feature checklist. Recorded traffic and AIR's own source code settled every detail. Where they disagreed, AIR's code won, because that is what renders the UI. |

### Prior art: why not reuse `pi-acp`

An existing adapter, **pi-acp** (MIT, aimed at Zed), already exposes Pi over ACP. It runs Pi as a subprocess
(`pi --mode rpc`) with the user's own Pi credentials. It knows nothing about AIR: no provider configuration, no AIR
proxy, no `_meta`.

**Decision:** keep our in-process design and port pi-acp's translation logic (tool titles, edit diffs, terminal
output, history replay) with attribution. Running Pi in-process is what lets the bridge register AIR's proxy as Pi's
model providers. It also keeps ACP and Pi in separate layers, whereas pi-acp is one class mixing both.

---

## 4. Architecture: the bridge

```
AIR ── stdio, JSON-RPC (ACP v1) ──►  ACP driver   framing, wire types, codec, method dispatch.
                                        │         Knows ACP and AIR's _meta. Knows nothing about Pi.
                                        ▼
                                     core          neutral types and ports: provider bindings, model groups,
                                        ▲          turn events (text, thoughts, tools, plans, questions),
                                        │          permission and question callbacks, backend/session interfaces.
                                        │
                                     Pi bridge     one Pi session per chat, Pi's model runtime wired to AIR's proxy,
                                                   Pi events -> turn events, permission gate, plugin adapters.
                                                   Knows Pi. Knows nothing about ACP.
```

- **Dependency rules, checked by a test:** core imports neither side, the driver never imports Pi, and the bridge
  never imports ACP. Only the entry point wires them together.
- **The driver** turns ACP requests into core calls and core events into ACP `session/update`s. All of AIR's `_meta`
  knowledge lives here.
- **The bridge** runs a Pi `AgentSession` per chat and turns Pi's event stream into neutral turn events.
- **Plugin adapters**: one small module per supported Pi plugin. Each knows that plugin's tools, saved state and
  quirks, and maps them to neutral events.
- **No client assumptions:** the client is whatever it says it is in ACP `initialize`. AIR-specific output is sent
  only when the client negotiated the matching capability, and model-facing text names the client as it introduced
  itself.

---

## 5. How AIR and an agent talk: the parts that shaped the design

| Step | Direction | Message | What it carries |
|---|---|---|---|
| 1 | AIR → agent | `initialize` | Protocol v1, client identity, AIR's capability list in `_meta`. The agent answers with its capabilities, including `providers`. |
| 2 | AIR → agent | `providers/list` | The agent returns its **fixed provider slots** (anthropic, openai, google, ingrazzio) and the API types each accepts. |
| 3 | AIR → agent | `providers/set` | Per slot: a local proxy URL (`http://127.0.0.1:<port>/jcp.acp.dynamic.<id>.<provider>`) and headers carrying the proxy key. |
| 4 | agent → proxy | model discovery | The agent asks the proxy which models the account may use, then publishes them. |
| 5 | AIR → agent | `session/new` | Working dir, MCP servers, skill roots. The answer holds the config options: mode, model (grouped), effort, Brave Mode. |
| 6 | AIR → agent | `session/prompt` | The user's message. The agent streams `session/update`s: text, thoughts, tool cards, plans, usage, title. |
| 7 | agent → AIR | `session/request_permission`, `elicitation/create` | Tool approvals, plan review, and questions to the user. |
| 8 | AIR → agent | `session/list`, `session/load`, `session/resume`, `session/cancel`, `session/set_config_option`, steering | History, reopening chats, stopping a turn, settings changes, messages typed while the agent works. |

**Calling models through AIR's proxy:**
- Each proxy route speaks the vendor's own protocol: Anthropic Messages, OpenAI Responses, Gemini, and Vertex. The
  only thing to get right is what the base URL already contains. For example, the OpenAI base already ends at `/v1`,
  and Vertex needs Junie's `/v1/projects/{p}/locations/{l}` path.
- The proxy authenticates the agent by the headers from `providers/set`. Pi's SDK insists on an API key, so the
  bridge registers a placeholder and strips it before any request leaves. The bridge never holds a real credential.
- **The model list is a policy, not a static list.** Like Junie, the bridge first asks the account's catalog
  (`/models/user`), then the vendor listing. It intersects the result with the models Junie's picker offers, and with
  the models Pi can describe. The model option is re-sent whenever discovery changes it.

---

## 6. Mapping AIR features to Pi: core, plugin or bridge

Each feature in Junie's AIR contract was sorted by where the agent-side behaviour comes from:
- **Pi core**: the SDK already does it, and the bridge maps it to ACP.
- **Pi plugin**: an existing package from the Pi ecosystem does it, and the bridge adapts it.
- **Bridge**: nothing in Pi fits, so pi-junie implements it.

| AIR feature | Source | Status |
|---|---|---|
| Initialize / client identity | Bridge | Done |
| Auth status | Bridge | Done (JetBrains AI label) |
| Provider model discovery and provider config | Bridge (Pi model runtime) | Done (all routes incl. Vertex and Ingrazzio) |
| Default model group (Junie's mixes) | Bridge (account feature flags) | Done (Eco reported off) |
| Session instructions | Pi core | Not yet (small) |
| Additional skill roots | Pi core | Done |
| Session list / load / resume | Pi core + bridge store | Done |
| Session archive / rename / delete | Bridge | Not yet |
| Session fork | Pi core | Not yet (small) |
| Steering (typing while the agent works) | Pi core | Done |
| Goal mode | Pi plugin (`@narumitw/pi-goal` or `pi-codex-goal`) | Postponed by choice |
| Todo list (AIR's Todo dock) | **Pi plugin** `@juicesharp/rpiv-todo` | Done |
| Plan mode and plan review | **Pi plugin** `@narumitw/pi-plan-mode` | Done (plan file link not yet) |
| Permission requests | Bridge (Pi has no permissions) | Done |
| Brave Mode (Safe / Auto / Brave) | Bridge | Done (Auto = rule-based read-only shell commands) |
| Elicitation forms (questions) | Bridge (Junie's `ask_user` tool) | Done |
| Commands and skills | Pi core | Done |
| Native subagent sessions | **Pi plugin** `@tintinweb/pi-subagents` | Done (foreground, parallel, chosen models) |
| Terminal output | Bridge (bash as a live terminal) | Done |
| Message phases (working vs answer) | Bridge | Done |
| Skill and MCP tool presentation | Bridge | Done (incl. the IDE tool router) |
| Context compaction | Pi core | Partly (`/compact`; automatic compaction not shown) |
| Typed session failures | Bridge | Done |
| Changed-file reports | Bridge | Not yet |
| Prompt suggestions | Bridge | Not yet (only terminal-UI plugins exist) |
| Usage and cost | Pi core | Done |
| Web search and fetch (not an AIR contract item) | **Pi plugin** `pi-web-access` | Done |

**Takeaway:** plugins matter for *agent behaviour* (subagents, plans, todos, web access, goals). Most AIR features are
*presentation* of things Pi already does, and that is bridge work in any case.

### How the plugins are adapted

| Plugin | What the bridge does with it |
|---|---|
| `@tintinweb/pi-subagents` 0.26 | Adopts each child Pi session, mirrors it to AIR's native child session, and sends the child's tool calls through the parent's permission gate. |
| `@juicesharp/rpiv-todo` 2.15 | Each `todo` result becomes Junie's `plan_update` items (shown in AIR's Todo dock) instead of a tool card, and is replayed when a chat is reopened. |
| `@narumitw/pi-plan-mode` 0.60 | Junie's `mode` option and AIR's `/plan` toggle drive the plugin's commands. The finished plan becomes a Markdown plan card. Junie's review (implement / revise / stop) goes through a permission request, and implementing continues in the same turn. |
| `pi-web-access` 0.48 | Its four tools are always on (its loader is left out) and shown as `search`/`fetch` cards. Searching runs without asking; fetching asks in Safe mode. A background option that would start runs on its own is turned off. |

**Plugins checked and set aside:** goal mode (postponed); token and cost dashboards, diff widgets and
prompt-suggestion plugins (they need Pi's terminal UI, which an ACP session lacks).

### How a plugin is checked, every time

1. Download it (`npm pack`) into a temporary directory and read the source. Downloaded code is treated as untrusted
   and installed without running its scripts. The questions:
   - Which tools does it register, and what do their results contain?
   - What state does it save?
   - What config and keys does it need?
   - What network or file side effects does it have?
2. Work out how it behaves without Pi's terminal UI, since bridge sessions have none.
3. Write a small stand-in with the same contract for fast tests, plus an optional test against the real package.
4. Find the matching shape in AIR's source code, map the plugin's state to it, then test in AIR.

The bridge detects plugins where `pi install npm:<name>` puts them and loads them into its sessions. A new chat's
welcome message lists each supported plugin as available (with its version) or not, with the install command.

---

## 7. What the investigation uncovered

Facts that changed the design. Each was found by reading recordings, AIR's or Junie's source, or our own logs.

**The `ingrazzio` slot**
- Junie lists one more provider slot than the vendors, and AIR answers it with a route to JetBrains' Ingrazzio API.
- Junie in AIR sends all its model traffic through that route, and reads the account's **feature flags** there
  (`GET <route>/api/feature-flags/ga`).
- pi-junie now asks for the slot too. AIR grants it and the flags load, which made two features possible:
  - **Junie's Default model group.** The `JUNIE_MIXES` flag defines Lite / Normal / Hard / Frontier, each a model,
    an effort and an Eco flag (currently: Junie Lite; GPT-6.1 Terra high; Claude Opus 5.5 high; Claude Fable 5.2
    high), with Normal recommended.
    - The bridge sends these levels with AIR's `defaultGroup` meta, so AIR shows the same Default slider as for
      Junie.
    - New chats start on the recommended level. Picking a model or effort by hand switches to a manual choice.
  - **Junie Lite.** Qwen3.6 27B on JetBrains' own server, called the way Junie calls it: OpenAI chat completions on
    Ingrazzio's vLLM path, with Ingrazzio's routing and free-license headers. It costs nothing.
- **Eco**, which Junie enables for three levels, means: the level's model plans, and a cheaper model from the
  `ECO_MODE_IMPLEMENTATION` flag (currently GPT-6 Luna) implements. Pi has no such split, so for now Eco is shown
  as off.

**AIR UI rules you can't see in the protocol**
- AIR finds its plan toggle through the `/plan` command's `commandAction` meta, and turns `/plan` into a settings
  change. Text typed after `/plan` therefore never reaches the agent.
- The Todo dock counts only completed items, keys rows by position, and doesn't open by itself.
- A plan review is attached to a plan card only when the review carries exactly the card's Markdown.
- When a chat opens, AIR re-applies the user's saved model, effort and Brave Mode. It warns about any setting the
  agent didn't apply, for example an effort on a model that has no effort control.

**Where Junie's extras come from**
- Junie's YouTrack and GitHub MCP servers come from Junie's own config (`~/.junie/mcp/mcp.json`), not from AIR.
- AIR passes the user's own MCP servers (`~/.jetbrains/mcp/mcp.json`) to an agent only if that agent's `acp.json`
  entry allows it (`use_custom_mcp`). Otherwise an agent gets only AIR's IDE server.

**Plugin and Pi quirks the bridge absorbs**
- Plugin commands start agent runs without waiting for them, so the bridge waits for those runs itself.
- Pi's tool allowlist hides plugin tools unless they are listed explicitly.
- A web plugin option starts a new run after a background fetch, possibly after the turn has ended. The bridge
  switches that option off.

---

## 8. How development worked

**The loop for each feature:**
1. Read the recorded Junie ↔ AIR traffic and the AIR code that handles it.
2. Write a replay or fake-proxy test.
3. Implement it in the driver and/or the bridge.
4. Run the full test suite and the type check, then commit.
5. The user tests the commit in AIR and reports with screenshots and log excerpts.
6. Fix from the agent's log, which records every ACP request, model call and tool call, with secrets redacted.

**Practices:**
- **Research before code.** For each plugin or AIR feature, findings and a proposal came first, and the user decided
  the open questions: which plan-mode plugin, the permission policy for web tools, Eco off for now.
- **Ground truth over documentation.** Recorded traffic and AIR's code decided every detail.
- **Safety:** the recordings contain keys, so they are never committed. Downloaded plugin code is read before use,
  and nothing is pushed without the user.

**Size:** about 50 commits over two days; about 5,000 lines of source and 2,800 lines of tests (130 tests plus one
optional test against a real plugin).

---

## 9. Where it stands

**Working and checked in AIR:**
- Model picker: discovery through AIR's proxy, the Default group, Junie Lite.
- Chat with thoughts and images.
- Tool cards with permissions and Brave Mode; bash as a live terminal.
- MCP servers, including AIR's IDE tools; skills and slash commands.
- Questions to the user, steering.
- Subagents, the Todo dock, plan mode with review, web search and fetch.
- Chat list, reopening and replaying chats, titles, usage and cost, typed failures.

**Known gaps:**
- Eco is shown as off.
- **Not yet done:** plan file links, goal mode, changed-file reports, prompt suggestions, session fork, archive and
  rename, automatic compaction events.
- In plan mode, the plan-mode plugin blocks MCP and web tools until its `defaultPlanTools` setting lists them.
- **YouTrack and GitHub MCP:** they need to be added to AIR's MCP config, with custom servers allowed for pi-junie in
  `acp.json`.
- **Packaging:** runs from a git clone with Node 22.19+ (macOS and Linux launcher). An install script and updated
  setup notes are still to do.

**Trying it today:**
1. Clone the repo and run `npm ci`.
2. Register `"pi-junie": {"command": "<clone>/bin/pi-air", "args": [], "env": {}}` in `~/.jetbrains/acp.json`.
3. Pick it in AIR.
4. Optionally install the plugins with `pi install npm:<name>`.

---

## 10. What can be gained next, and what to expect

**Near-term, each a small, contained step:**
- **Real Eco:** the level's model plans and the cheaper Eco model implements through a subagent. This makes Normal,
  Hard and Frontier cheaper, the way Junie's are.
- **Web search through Ingrazzio,** as Junie does, instead of the plugin's default third-party search service.
- **Plan file links, changed-file reports, session fork,** and the plan-mode tool allowlist.
- **An install script and setup notes,** so colleagues can get running in minutes.

**Longer-term value:**
- **A second, open agent in AIR with AIR's full UI.** Pi's plugin ecosystem and fast model support, while users keep
  AIR's picker, cards, plans and subagents.
- **A reusable way to bring any ACP agent into AIR.** The driver, the core interfaces and the knowledge of AIR's
  `_meta` are agent-neutral, so another agent needs a new bridge, not a new driver.
- **A tested, executable description of AIR's agent contract,** useful when that contract changes and for the move
  to ACP v2.

**Realistic expectations and risks:**
- **UI parity with Junie is achievable, and mostly done.** Answer quality depends on Pi and the chosen model, not
  on the bridge.
- **Internal JetBrains contracts can change without notice.** The Ingrazzio route, the feature-flag format, the
  free-license headers and AIR's `_meta` keys are internal and mirrored from Junie.
  - Most are versioned, and the bridge falls back to plain behaviour when something is missing.
  - Use beyond the company should be agreed with the AIR and Junie teams.
- **Third-party plugins evolve.** The bridge relies on each plugin's contract (tool names, result shape, saved
  state). Real-plugin tests catch breaking changes, but plugin updates should be tried before rolling them out.
- **Maintenance follows Pi SDK and AIR releases.** The replay tests and the agent log make each upgrade cheap to
  verify.
