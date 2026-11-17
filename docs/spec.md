# pi-junie: Pi as an ACP agent for JetBrains AIR

Status: draft, 2026-11-17

## 1. Goal

AIR (the JetBrains AI client in the IDE) can start Pi as an ACP agent, the same way it starts Junie. The
first milestone is:

1. AIR starts Pi from `~/.jetbrains/acp.json`, and the ACP handshake succeeds.
2. AIR configures its LLM proxy through `providers/list`, `providers/set` and `providers/disable`.
3. AIR's model picker shows the models Pi offers for the providers AIR has set.
4. The user can chat with the selected model in a plain conversation, with no tools.

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
  providerSlots(): ProviderSlot[];                  // fixed list (anthropic, openai, google)
  bindProvider(b: ProviderBinding): void;           // from providers/set
  unbindProvider(providerId: string): void;         // from providers/disable
  availableModels(): ModelGroup[];                  // only bound slots
  openSession(req: { cwd: string }): Promise<BackendSession>;
}
interface BackendSession {
  id: string;
  currentModel(): ModelRef | undefined;
  selectModel(ref: ModelRef): Promise<void>;
  prompt(text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult>;
  close(): Promise<void>;
}
```

The driver owns everything ACP-specific: config option ids, the model value encoding (`pi:<slot>/<modelId>`),
group ids (`proxy:<slot>`), `_meta` shapes and stop reasons.

### 3.2 Pi bridge

- Default model: `anthropic/claude-sonnet-5-5` when available, otherwise the first available.
- **Models come from proxy discovery** (`src/pi/discovery.ts`, same algorithm as Junie, see
  `docs/junie-proxy-triage.md` §4.1): the account catalog (`/models/user`), else the vendor listing, narrowed by
  `_meta.jetbrains.air.selectedModels`, limited to **Junie's picker policy** (its non-deprecated `ModelOption`
  entries, `picker` in `src/pi/catalog.ts`) for vendor listings, and matched to Pi's catalog. Unknown ids are dropped and logged as
  `[models-todo]`. A failed discovery offers no models (no fallback). `session/new` waits up to 10 s for discovery;
  later results arrive as `config_option_update`.
- Fixed slots, like Junie's: `anthropic` (apiType `anthropic`), `openai` (`openai`) and `google`
  (`google`/`vertex`, experimental).
- `bindProvider` registers a **separate** Pi provider `air-<slot>` with `baseUrl` and `headers` from AIR,
  a placeholder API key, and the curated models copied from Pi's built-in catalog. It never overrides the
  user's real `anthropic`/`openai` providers, so the user's own credentials are never sent to the AIR proxy.
- Each ACP session gets one Pi `AgentSession` with Pi's coding system prompt plus an IDE note, the built-in
  tools `read grep find ls edit write bash`, the project's context files (`AGENTS.md`/`CLAUDE.md` in the
  working directory and its parents) and skills (`.agents/skills`, `.pi/skills`, `~/.agents/skills`; the
  project counts as trusted unless `PI_AIR_TRUST_PROJECT=0`), and Pi's default auto-compaction. No
  extensions, prompt templates, or the user's own `~/.pi/agent` settings, instructions and skills (isolated
  `agentDir`). Each session logs the context files and skills it loaded.
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
- stdout belongs to ACP. The host redirects `console.log` to stderr.

### 3.3 Compatibility layer (src/compat)

A registry of AIR features (`_meta.jetbrains.air.capabilities` strings) with the Pi-side requirements
that unlock each one:

```ts
{ feature: "nativeSubagentSessions", requires: [{ extension: "pi-subagents", version: ">=1.0.0" }], status: "planned" }
{ feature: "customInstructions",     requires: [], status: "planned" }
```

- `resolve(installed: InstalledExtension[], clientFeatures: string[])` returns the features to advertise
  in the `initialize` result, plus a diagnostic list of features that are unavailable and why.
- Two directions: installed extensions decide what is advertised, and features AIR asks for that can't be
  met are reported as missing requirements.
- For now every entry is `planned`, so nothing is advertised. The module exists so features can be turned
  on one entry at a time.

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
"pi-junie-dev": { "command": "<repo>/bin/pi-air", "args": [], "env": {} }
```

`PI_AIR_LOG=<file>` writes a wire log (both directions) for debugging and for future fixtures.

## 6. Milestones

1. Spec, repo layout, and fixture extraction.
2. ACP driver and core plus replay tests with `FakeBackend` (handshake, providers, session/new model list).
3. Pi bridge: provider binding and curated models; the model list comes from Pi's catalog.
4. Prompting: plain chat through the AIR proxy, streaming, cancel, model switch.
5. Launcher, the acp.json entry, and a live check in AIR.
6. Next: more fixtures, v2 codec, compat entries (subagents etc.), `session/list` persistence.

## 7. Out of scope for now

File/terminal client capabilities, auth methods,
 plans and goal mode, subagents, `_providers/models`, ACP v2 steering (`session/prompt` during a turn).
