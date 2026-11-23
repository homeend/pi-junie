# pi-junie: Pi as an ACP agent for JetBrains AIR

Status: living spec, last updated 2026-11-23. Sections 1 and 6 record the original first milestone; everything
else describes the current code.

## 1. Goal

AIR (the JetBrains AI client in the IDE) can start Pi as an ACP agent, the same way it starts Junie. The
first milestone is:

1. AIR starts Pi from `~/.jetbrains/acp.json`, and the ACP handshake succeeds.
2. AIR configures its LLM proxy through `providers/list`, `providers/set` and `providers/disable`.
3. AIR's model picker shows the models Pi offers for the providers AIR has set.
4. The user can chat with the selected model in a plain conversation, with no tools.

That milestone is done. The bridge has since become a full coding agent (tools, permissions, sessions, plugins,
plans, subagents, web access, the Default model group); §3.2 and §3.3 describe it.

ACP stays behind a driver. Pi stays behind a bridge. Neither leaks into the other.

## 2. What the wire shows (Junie <-> AIR, ACP v1)

Based on the recorded sessions in `acp-examples/` (not committed). The extracted, trimmed fixtures live in
`test/fixtures/`.

| # | Direction | Method | Notes |
|---|---|---|---|
| 1 | AIR -> agent | `initialize` | `protocolVersion: 1`, `clientCapabilities._meta.jetbrains.air {version, capabilities[]}`, `clientInfo.name = "air-plugin:<ide>"` |
| | agent -> AIR | result | `agentCapabilities.providers: {}` enables provider configuration. `_meta.jetbrains.air.capabilities[]` lists the AIR features the agent supports. Also `authMethods` and `agentInfo`. |
| 2 | AIR -> agent | `providers/list` | Agent returns its **fixed provider slots**: `{providerId, supported: [apiType...], required, current: {apiType, baseUrl} \| null}` |
| 3 | AIR -> agent | `providers/set` | `{providerId, apiType, baseUrl, headers}`. The baseUrl is AIR's local proxy (`http://127.0.0.1:<port>/jcp.acp.dynamic.<id>.<provider>`), and the headers carry the proxy key. Result `{}` |
| 4 | AIR -> agent | `providers/disable` | `{providerId}` for slots AIR cannot serve. Result `{}` |
| 5 | AIR -> agent | `session/new` | `{cwd, mcpServers, _meta}`. The result has `sessionId` and `configOptions`; the `model` option (`category: "model"`) is a grouped select |
| | agent -> AIR | `session/update` | `config_option_update`, `available_commands_update`, `session_info_update`, `usage_update` |
| 6 | AIR -> agent | `session/prompt` | `{sessionId, prompt: [{type:"text", text}]}` |
| | agent -> AIR | `session/update` | `agent_message_chunk` deltas, then the response `{stopReason: "end_turn", usage}` |
| 7 | AIR -> agent | `session/list` | Called repeatedly. The agent must answer, and `{sessions: []}` is valid |
| 8 | AIR -> agent | `session/close`, `session/cancel` | |

**How models reach AIR.** `providers/list` does not return models. The agent advertises fixed provider
*slots*. AIR binds its proxy to each slot with `providers/set`. The agent then publishes the models it can
reach through those bindings as the `model` config option on `session/new`, and as a
`config_option_update` when they change. Junie's option values look like
`v1:15:proxy:ingrazzio:claude-opus-5-5`, grouped by provider, with optional
`_meta.jetbrains.air {eco, badge, modelDisplayName}`. Pi follows the same pattern: fixed slots, plus a
curated model list per slot.

**Ingrazzio slot** (`src/pi/ingrazzio.ts`). Like Junie, the agent also lists an `ingrazzio` slot (apiType
`ingrazzio`, JetBrains' own API). When AIR binds it, the bridge reads the account's feature
flags through that route, `GET <baseUrl>/api/feature-flags/ga` with the binding's headers, as Junie does
(`RemoteFeatureFlags.kt`). The flags include `JUNIE_MIXES` (Junie's Default model group: Lite/Normal/Hard/Frontier as
model + effort + Eco) and `ECO_MODE_IMPLEMENTATION`. The bridge logs them and builds the Default group from
`JUNIE_MIXES` (below); `ECO_MODE_IMPLEMENTATION` is logged only (no Eco in Pi).
It also offers **Junie Lite** (group "JetBrains AI") there, called like Junie does: Qwen3.6 27B
(`Qwen/Qwen3.6-27B-FP8`) as OpenAI chat completions at `<baseUrl>/llm/vllm/v1/chat/completions`, with Ingrazzio's
routing headers `X-LLM-Model: jbai`, `X-Keep-Path: true` and the free license (`X-Forced-License-Free: true`,
`X-Accept-EAP-License: false`, `X-Accept-Release-License: false`); no effort. Ingrazzio has no vLLM listing, so it is
offered without discovery (as in Junie).

**Default group** (`src/pi/mixes.ts`). From `JUNIE_MIXES` (schema 1: `recommended` plus presets `{id, label,
description, selection: {modelId, effort, ecoMode}}`) the bridge builds Junie's Default group: the first group of
the `model` option, `{group: "default", name: "Default", _meta.jetbrains.air: {version: 1, defaultGroup:
{description}}}`, with values `mix.<id>` carrying `_meta.jetbrains.air {eco: "off", modelDisplayName}`. A level is
listed only when its model is reachable (Junie's setting id, matched like discovery; `junie-lite` = Junie Lite) and
supports its effort. Picking a level sets its model and effort; a new chat starts on the recommended level; picking
a model or an effort by hand makes the choice manual (`currentValue` becomes the model). Eco is always reported
off: Pi has no Eco mode (Junie: the level's model plans, `ECO_MODE_IMPLEMENTATION`'s model implements).

ACP version: v1, matching the Junie examples. The codec keeps version-specific paths (v1
`clientCapabilities`/`agentCapabilities`, v2 `capabilities`) in one place so v2 can be added later.

## 3. Architecture (bridge pattern)

```
 AIR ──stdio/ndjson──► ┌──────────── ACP driver (src/acp) ─────────────┐
                       │ jsonrpc.ts   framing, request/response, errors │
                       │ wire.ts      raw v1 wire types + AIR _meta     │
                       │ codec.ts     wire  <->  core types            │
                       │ agent.ts     method dispatch, session/update   │
                       └───────────────▲───────────────────────────────┘
                                       │ core types + ports only
                       ┌───────────────┴──── core (src/core) ──────────┐
                       │ types.ts   ProviderSlot, ProviderBinding,     │
                       │            ModelChoice, TurnEvent, ...        │
                       │ ports.ts   AgentBackend (implemented by the   │
                       │            bridge), TurnSink                  │
                       └───────────────▲───────────────────────────────┘
                                       │
                       ┌───────────────┴──── Pi bridge (src/pi) ───────┐
                       │ catalog.ts   fixed slots + curated models     │
                       │ backend.ts   ModelRuntime providers,          │
                       │              AgentSession per ACP session     │
                       └───────────────────────────────────────────────┘
                       ┌──── compat (src/compat) ──────────────────────┐
                       │ AIR feature <-> required Pi extensions        │
                       └───────────────────────────────────────────────┘
```

Dependency rules, checked by test (`test/architecture.test.ts`):

- `src/core` imports nothing from `acp`, `pi`, ACP SDKs or `@earendil-works/*`.
- `src/acp` imports only `core` and `compat` (no Pi).
- `src/pi` imports only `core` and Pi packages (no ACP).
- `src/main.ts` is the composition root and the only file that wires everything together.

This is the same split the Obsidian plugin uses: `acp/` confines the protocol, and an internal
`SessionUpdate` union is the single channel to the rest.

### 3.1 Core ports (sketch)

```ts
interface AgentBackend {
  info(): AgentIdentity;
  providerSlots(): ProviderSlot[];                  // fixed list (anthropic, openai, google, ingrazzio)
  bindProvider(b: ProviderBinding): void;           // from providers/set
  unbindProvider(providerId: string): void;         // from providers/disable
  availableModels(): ModelGroup[];                  // only bound slots
  modelMixes(): ModelMix[];                         // the Default group's runnable levels
  openSession(req: { cwd: string }): Promise<BackendSession>;
}
interface BackendSession {
  id: string;
  currentModel(): ModelRef | undefined;
  selectModel(ref: ModelRef): Promise<void>;
  currentMix(): string | undefined;                 // Default group level, while its model and effort hold
  selectMix(id: string): Promise<void>;
  prompt(text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult>;
  close(): Promise<void>;
}
```

The real ports (`src/core/ports.ts`) also cover effort, modes, steering, permissions, questions, session
list/load and titles. The driver owns everything ACP-specific: config option ids, the model value encoding (`pi:<slot>/<modelId>`),
group ids (`proxy:<slot>`), `_meta` shapes and stop reasons.

### 3.2 Pi bridge

- Default model for a new chat: the recommended Default group level when the ingrazzio slot is bound and the level
  is runnable, else `anthropic/claude-sonnet-5-5` when available, otherwise the first available.
- **Models come from proxy discovery** (`src/pi/discovery.ts`, same algorithm as Junie, see
  `docs/junie-proxy-triage.md` §4.1): the account catalog (`/models/user`), else the vendor listing, narrowed by
  `_meta.jetbrains.air.selectedModels`, limited to **Junie's picker policy** (its non-deprecated `ModelOption`
  entries, `picker` in `src/pi/catalog.ts`) for vendor listings, and matched to Pi's catalog. Unknown ids are dropped and logged as
  `[models-todo]`. Exception: a picker entry with `like` (Junie says it has the same capabilities as a model Pi
  knows, e.g. gemini-4-hydrogen/carbon like gemini-4-argon) is offered as a copy of that Pi model with Junie's
  prices, and still logged as `[models-todo]` until Pi knows it. A failed discovery offers no models (no fallback). `session/new` waits up to 10 s for discovery;
  later results arrive as `config_option_update`.
- Fixed slots, like Junie's: `anthropic` (apiType `anthropic`), `openai` (`openai`), `google`
  (`google`/`vertex`) and `ingrazzio` (`ingrazzio`, see §2).
- `bindProvider` registers a **separate** Pi provider `air-<slot>` with `baseUrl` and `headers` from AIR,
  a placeholder API key, and the curated models copied from Pi's built-in catalog. It never overrides the
  user's real `anthropic`/`openai` providers, so the user's own credentials are never sent to the AIR proxy.
- Each ACP session gets one Pi `AgentSession` with Pi's coding system prompt plus a client note (the client as it named itself in initialize `clientInfo`, never assumed; `@path` mentions are paths), the built-in
  tools `read grep find ls edit write bash`, the project's context files (`AGENTS.md`/`CLAUDE.md` in the
  working directory and its parents) and skills (`.agents/skills`, `.pi/skills`, `~/.agents/skills`; the
  project counts as trusted unless `PI_AIR_TRUST_PROJECT=0`), and Pi's default auto-compaction. No
  extensions besides the bridge's own and the detected plugins (§3.3), no prompt templates, and none of the user's
  own `~/.pi/agent` settings, instructions and skills (isolated `agentDir`). Each session logs the context files and skills it loaded.
- **Permissions:** an inline Pi extension handles `tool_call`. Read-only tools (`read grep find ls`) run;
  `edit write bash` ask the user through the core `PermissionAsk` port, which the driver maps to
  `session/request_permission` (Allow once / Allow for this chat / Reject). A rejection or cancellation
  blocks the call, and the model sees "The user rejected this tool call."
- **Client MCP servers:** `mcpServers` from `session/new` / `session/resume` / `session/load` (AIR passes
  its `jetbrains_air_ide` stdio server, and a private HTTP server because we advertise
  `mcpCapabilities.http`) become core `McpServerSpec`s. The bridge registers them with
  `pi.registerMcpServer` (exposure `direct`) and loads Pi's MCP extension, which connects them on
  `session_start`. Their tools reach the model as `mcp__<server>__<tool>`. Tools the server marks
  `readOnlyHint` run without asking; the others go through the permission gate. SSE servers are skipped.
- **AIR skill roots:** `additionalDirectories` (else `_meta.additionalRoots`) on new/resume/load; each root's
  `.agents/skills` and `.junie/skills` are loaded as Pi skills (AIR's IDE skills such as `ij-debugger`).
- **Junie compatibility profile** (`src/pi/junie-compat.ts`, explicit and switchable): AIR's IDE skills are
  written for Junie, which shows the IDE router as `execute_tool` with its own wrapper description. With
  `executeToolAlias` (default on, `PI_AIR_JUNIE_EXECUTE_TOOL=0` turns it off) Pi registers a tool named
  `execute_tool` with Junie's description that forwards to `mcp__jetbrains_air_ide__execute_tool`; the MCP
  router itself stays callable but is not declared (`toolExposure: codemode`). The forwarded call is approved
  with its parent and gets no separate tool card.
- **Config options** on session/new, resume and load: `mode` (Default / Plan, with the plan-mode plugin), `model`
  (Default group first, then one group per bound slot), `effort` (Junie's `thought_level` select with the selected
  model's Pi thinking levels, `off` left out, recommended `medium`; absent for models without reasoning) and
  `brave_mode`. Each change answers with the full option list.
- **Commands:** after `session/new` / resume / load the driver sends `available_commands_update` with the
  session's `CommandInfo`s: `new` (AIR `commandAction: openNewSession`), `compact` (free-text instructions),
  and every loaded skill as `$<skill>` with AIR's `_meta.jetbrains.air {kind: "skill", skillPath}`. A prompt
  starting with `/name` or `$skill` (also `/skill:name`) is decoded into `PromptInput.command`; the bridge runs
  `/compact` as Pi compaction ("nothing to compact yet" for short chats) and skills through Pi's own
  `/skill:name args` invocation.
- **Steering (typing while Pi works)**, Junie's v1 contract: `initialize` advertises
  `_meta.steering.supported: true`, so AIR sends a message typed during a turn as `_session/steering
  {sessionId, prompt}` instead of queueing it. The driver asks the backend (`BackendSession.steer`):
  - running turn: the bridge queues it with Pi's `steer()` (read after the tools running now, before the next
    model call) and answers `{outcome: "injected"}`; the running `session/prompt` response still ends the turn.
    A message that reaches Pi after its last queue check is run in the same turn (never dropped). `$skill`
    expands into the running task.
  - no turn (the turn ended meanwhile): the driver starts a new turn with it, answers `startedNewTurn`, and
    ends that turn with Junie's carrier, an empty `agent_message_chunk` with top-level
    `_meta.lastRequestComplete: true`. A `session/prompt` during that turn gets -32000, steering joins it.
  - `/compact` (needs its own turn) or any message while `/compact` runs: -32602 with
    `data.reason: "steering_turn_busy"`; AIR keeps the message and sends it when the turn is idle.
  - Unknown session: -32002.
- **Tool events** (`src/pi/tools.ts`, ported from pi-acp, MIT) become neutral `ToolUpdate`s (title, kind,
  status, input, locations with the edit line, output text, edit/write diffs from a pre-execution snapshot).
  The driver turns the first update of an id into `tool_call` and later ones into `tool_call_update`.
- **Questions to the user** (`src/pi/ask-user.ts`): when the client advertises form elicitation
  (`clientCapabilities.elicitation.form`, AIR does), Pi gets Junie's `ask_user` tool (same name, schema,
  description and result text). It runs without a permission prompt and asks through the core `QuestionAsk`
  port; the driver sends `elicitation/create` (mode `form`) in Junie's shape: `question_<i>` as text, single
  choice (`oneOf`) or multi choice (array of `anyOf`), plus an "Other" text `question_<i>_custom` with AIR's
  `customAnswer` marker; nothing required. Accept returns the answers; decline/cancel tell the model not to ask
  again this turn. Cancelling the turn cancels the form. Shown as a "think" tool card "Asked: <names>".
- **Failures** (`src/pi/failures.ts`): a failed turn carries a neutral `TurnFailure` (category connection /
  access / limit / request / service / unknown, one-line title, the provider's message as details, actions
  retry / new_session), classified from Pi's error (HTTP status, network errors, Pi's context-overflow check).
  For a client with AIR's `sessionFailure` capability the driver sends Junie's typed row
  (`session_info_update` + `_meta.jetbrains.air.sessionFailure`, id `turn-<n>:error`, revision 1); otherwise
  an "**Error:**" message chunk. The prompt still ends with `end_turn`, like Junie v1.
- **Message phases** (`src/pi/phases.ts`), like Junie: each assistant text chunk is `commentary` (written while
  working, before tool calls) or `final_answer`, sent as `_meta.jetbrains.air.phase` (plus Junie's `codex` and
  `junie` keys). The first text of a message is held up to 1.5 s / 600 chars: a tool call starting meanwhile makes
  it commentary, OpenAI's own phase (Pi's text signature) decides when present, otherwise it streams as the
  answer. Replayed history uses the same rule (text of a message that called tools = commentary).
- Pi output is mapped to core `TurnEvent`s (`text`, `thought`, `usage`, `title`, `tool`) and nothing ACP-shaped.
- Sessions are persisted under `~/.pi/pi-junie/sessions` (metadata JSON + Pi transcript with the same id).
  `session/resume` reopens them; `session/list` returns prompted sessions (newest first, AIR's `list.limit`,
  `_meta.jetbrains.air` with `archived:false`, `lastPromptAt`); `session/load` replays the transcript's active
  branch as `user_message_chunk` / `agent_thought_chunk` / `agent_message_chunk` + the title, then answers. AIR restarts the agent whenever the LLM proxy identity changes (auth source
  switch, BYOK) and resumes the open chat; without resume it reports "This agent cannot resume the saved session".
- **Fork** (`session/fork`, Junie's v1 shape, advertised as `sessionCapabilities.fork`): AIR's "Open in New Session"
  (behind its registry key `air.sessions.fork`) into the current project or into a worktree AIR has just made, given
  as `cwd`. The bridge copies the source's Pi transcript into a new session working in that `cwd` (Pi's `forkFrom`)
  and its settings (model, effort, Default level, Brave Mode, title); the fork starts in Default mode and is live at
  once (`{sessionId, configOptions}`), AIR then loads it. List rows carry `_meta.jetbrains.air.forkedFrom`. Files are
  not rewound (as in Junie). Not yet: the fork point (`_meta.jetbrains.air.fork`, a response to fork at); the whole
  conversation is copied and the point is logged.
- stdout belongs to ACP. The host redirects `console.log` to stderr.

### 3.3 Compatibility layer (src/compat)

A registry of AIR features (`_meta.jetbrains.air.capabilities` strings) with the Pi-side requirements
that unlock each one:

```ts
{ feature: "nativeSubagentSessions", requires: [{ plugin: "@tintinweb/pi-subagents", minVersion: "0.26.0" }], status: "planned" }
{ feature: "customInstructions",     requires: [], status: "planned" }
```

- `resolve(installed: InstalledExtension[], clientFeatures: string[])` returns the features to advertise
  in the `initialize` result, plus a diagnostic list of features that are unavailable and why.
- Two directions: installed extensions decide what is advertised, and features AIR asks for that can't be
  met are reported as missing requirements.
- Only `nativeSubagentSessions` is `available` (advertised when `@tintinweb/pi-subagents` is installed); the other
  entries are `planned`. Features that need no capability string (plans, plan review, Brave Mode, web access, the
  Default group) are not in the registry.
- Installed plugins come from `src/pi/plugins.ts`: the user installs a known Pi package with Pi itself
  (`pi install npm:@tintinweb/pi-subagents`); the bridge finds it where `pi install` puts it
  (`<pi agent dir>/npm/node_modules/<name>`, `~/.pi/agent` or `$PI_CODING_AGENT_DIR`), reports name + version,
  and loads it into every session by path (`additionalExtensionPaths`; other on-disk extensions stay off).
  `PI_AIR_PLUGINS=0` skips plugins.
- Welcome: a new chat (session/new only, not resume/load) opens with one `agent_message_chunk` from the agent,
  sent after the response: the Pi version and, for each known plugin (subagents, todo list, plan mode, web access),
  whether it is available (with the install command when not). It is not part of the Pi transcript, so it is not replayed. `PI_AIR_WELCOME=0` turns it off. The
  startup log also says `subagents: available` / `subagents: not available`.
- Known plugins (`KNOWN_PLUGINS`): `@tintinweb/pi-subagents`, `@juicesharp/rpiv-todo`, `@narumitw/pi-plan-mode`,
  `pi-web-access`. Sessions enable only their listed tools (Pi's tool allowlist).
- Subagents (`@tintinweb/pi-subagents`, chosen because its children are in-process Pi sessions on the
  bridge's model runtime, reachable as live `AgentSession`s): sessions get its `Agent`, `get_subagent_result`
  and `steer_subagent` tools (they run without asking; the children's own tools are gated).
- Subagent child sessions (`src/pi/subagents.ts`): the plugin builds each child with `createAgentSession` +
  `bindExtensions` inside the parent's `Agent` call. The bridge observes `AgentSession.bindExtensions` once per
  process; a session bound inside a bridge turn (AsyncLocalStorage scope) that the bridge did not create is that
  turn's child. The child is announced with its `Agent` call (matched by prompt; `subagent_type` = name,
  `description` = task, `prompt`), its events go through the same `TranscriptStream` as the parent's, its tool
  calls pass the parent's permission gate (wrapped around Pi's `agent.beforeToolCall`, after the plugin's own
  hooks; "Allow for this chat" is shared with the parent), and it finishes when its `Agent` call returns.
  `Agent` calls are forced to the foreground (`run_in_background: false`), so children live within the turn and
  parallel `Agent` calls run concurrently (Pi's parallel tool execution).
- ACP (when the client lists `nativeSubagentSessions`, advertised once the plugin is present): `subagent_spawned`
  on the parent (`capabilities: {cancel:false, close:false}`), the child's transcript as ordinary updates on the
  child id (`<parent>:subagent-<n>`), child permission requests on the child id, `subagent_state_update` on the
  parent; the parent's `Agent` tool rows are hidden. Without the capability, only the `Agent` rows show.
  Not yet: background subagents, replay of children on session/load.
- Brave Mode (Junie's `brave_mode` select, category `mode`, values `brave-auto` / `on` / `off` labelled Auto / Brave /
  Safe, booleans accepted): per session, persisted in the session metadata, default Auto (Junie's default). Safe asks
  for every tool that is not read-only; Auto also runs read-only shell commands without asking
  (`src/pi/safe-commands.ts`: a quote-aware rule list of read-only commands and git subcommands, no redirection or
  substitution; Junie uses an LLM classifier instead); Brave asks for nothing. Subagents' tools follow the parent's
  mode.
- Subagent models: with the plugin present, every prompt's system prompt lists the session's available models
  (`provider/id`, display name, which one the session uses) for the `Agent` tool's `model` parameter, so the
  agent can offer them (e.g. through `ask_user`). A child run on a chosen model is named `<type> · <model id>`.
- Todo list as the plan (`@juicesharp/rpiv-todo`, `src/pi/todo.ts`): with the plugin installed, sessions get its
  `todo` tool (runs without asking). Each successful call returns the whole list (`details.tasks`); the bridge
  sends it as the plan (non-deleted tasks: subject + pending / in_progress / completed, priority `medium`) instead
  of the tool's rows. Clients with the standard `plan` client capability (AIR) get Junie's v1
  `plan_update {plan: {type: "items", id: "main", entries}}` and `plan_removed {id: "main"}` for an empty list;
  others get the standard `plan {entries}`. session/load replays the list as it was last. A subagent's list goes
  to its child session. The welcome message says whether the todo list is available.
- Plan mode (`@narumitw/pi-plan-mode`, `src/pi/plan-mode.ts`): the plugin owns the mode (read-only tools, the
  model hands in the plan with `plan_mode_complete` or a `<proposed_plan>` block, then waits for a decision; its
  state is the custom entry `plan-mode-state`). Its decision menu needs Pi's TUI, so the bridge drives it:
  - Junie's `mode` select (Default / Plan, listed first) and a `/plan` command whose `_meta.commandAction`
    (`setConfigOption` mode plan/default, `presentation: state`, top level and under `jetbrains.air`) is AIR's
    plan toggle. `/plan <task>` switches on and plans the task, `/plan off` leaves. The choice is kept in the
    session metadata and applied with the plugin's `/plan start` / `/plan exit` before the next prompt.
  - After a run, a new awaiting plan is sent as `plan_update {type: "markdown", id: "plan"}` (clients without plan
    updates: as a message) and reviewed like Junie v1: `session/request_permission`, tool call
    `plan-review:<uuid>` "Implement this plan?" with `rawInput.plan` (same Markdown, which AIR uses to attach the
    review to the plan card), options `implement` / `revise` / `stop`, then a `tool_call_update` completed.
  - implement: `/plan implement` (the plugin sends "Implement the plan." without awaiting it; the bridge waits for
    that run) in the same turn; stop: `/plan exit`; revise: the turn ends, the next message revises. Mode changes
    during a turn send `config_option_update`. Replay shows the plan card instead of the plan tool's row.
  - Limits: in plan mode the plugin allows only its read-only built-in tools (MCP, `ask_user`, subagents and todo
    need its `defaultPlanTools` setting); its question tool needs Pi's TUI. No plan file (`planFile`) yet.
- Web access (`pi-web-access`, `src/pi/web-access.ts`): sessions get `web_search`, `source_check`, `fetch_content`
  and `get_search_content` directly; the plugin's `web_enable` loader is left out, so the tools are always there.
  Rows: `web_search`/`source_check` kind `search` ("Search the web: \"…\"", "Check claim: \"…\""),
  `fetch_content`/`get_search_content` kind `fetch` ("Fetch <url>"); output is the plugin's Markdown text.
  Searching and stored results run without asking; `fetch_content` (pages, PDFs, GitHub clones with the user's `gh`
  login, local videos) asks in Safe mode and runs in Auto/Brave. `web_search`'s `includeContent` is forced off: its
  background fetch starts an agent run of its own when done, possibly after the turn. Without keys the plugin searches
  through Exa's hosted MCP; keys and providers go in `~/.pi/agent/web-search.json`. Its TUI commands (`/websearch`,
  `/curator`, `/search`) are not offered; renamed tools (`toolNames` in its config) are not supported. In plan mode
  the plan-mode plugin blocks the web tools unless its `defaultPlanTools` lists them.

## 4. Testing: replay simulator

- `scripts/extract-fixture.ts <acp-messages.jsonl> <name>` turns a recorded Junie session into
  `test/fixtures/<name>.json`:
  ```json
  { "name": "...", "source": "...", "client": [ /* AIR -> agent messages, in order */ ],
    "reference": [ /* Junie's replies, for reading only */ ] }
  ```
  It strips IDE-specific noise (MCP server env tokens, proxy keys are replaced with placeholders).
- `test/harness.ts` runs the real ACP driver over an in-memory transport against a `FakeBackend`, or
  against the real Pi bridge with a stubbed model. It replays the `client` messages in order and waits for
  each request's response.
- Tests check behaviour, not byte equality with Junie: every request gets a response with the same id,
  the right backend calls happen, the model option lists the bound slots' models, and prompts stream
  `agent_message_chunk` and end with `end_turn`.
- New AIR <-> Junie recordings become new fixtures, and failing tests show what is still missing.

## 5. Running in AIR

`bin/pi-air` (bash) runs `node src/main.ts`. It's registered in `~/.jetbrains/acp.json`:

```json
"pi-junie": { "command": "<repo>/bin/pi-air", "args": [], "env": {} }
```

The log goes to `.pi-dev/pi-air.log` (`PI_AIR_LOG=<file>` overrides it): the wire in both directions, secrets
redacted, plus diagnostics. It is the source for debugging and for future fixtures.

## 6. Milestones

1. Spec, repo layout, and fixture extraction.
2. ACP driver and core plus replay tests with `FakeBackend` (handshake, providers, session/new model list).
3. Pi bridge: provider binding and curated models; the model list comes from Pi's catalog.
4. Prompting: plain chat through the AIR proxy, streaming, cancel, model switch.
5. Launcher, the acp.json entry, and a live check in AIR.
6. Done since: tools and permissions, sessions (list, load, resume), effort, commands and skills, client MCP
   servers, steering, failures, phases, plugins (subagents, todo list, plan mode, web access), the ingrazzio slot
   with Junie Lite and the Default group.
7. Next (not started): real Eco, plan file links, plan-mode `defaultPlanTools`, goal mode, changed-file reports,
   fork points, session archive / rename, session instructions, ACP v2 codec.

## 7. Out of scope for now

File/terminal client capabilities (AIR sends `fs:false`, `terminal:false`), auth methods, `_providers/models`,
ACP v2 steering (`session/prompt` during a turn), background subagents.
