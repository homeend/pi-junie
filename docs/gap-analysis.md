# Gap analysis: a normal chat in AIR

Inputs:
- the ACP v1 schema (`@agentclientprotocol/sdk` 2.7.0, `dist/v1/schema`)
- the Junie <-> AIR wire (fixtures, `~/.junie/logs/junie-acp-*.log`)
- the existing Pi adapter **pi-acp** 0.0.34 (MIT, github.com/svkozak/pi-acp; AIR's registry already lists it
  as `acp.registry.pi-acp`)
- our live log `.pi-dev/pi-air.log`

## 1. pi-acp in one paragraph

An ACP agent over stdio built on the ACP SDK (`AgentSideConnection`). It **spawns `pi --mode rpc`** and turns
Pi's RPC event stream (the same `AgentSession` events our bridge gets in-process) into ACP updates. It covers
text, thoughts, tool calls (including bash as terminal output and edit/write as structured diffs, with file
locations), `session/load` with history replay from Pi session files (`~/.pi/pi-acp/session-map.json`),
`session/list`, slash commands (prompt files, skills, built-ins like `/compact` and `/session`), usage, session
titles, Pi extension UI requests mapped to `session/request_permission`, and terminal auth.

It knows nothing about AIR: no `providers/*`, no `_meta.jetbrains.air`, no proxy discovery. It uses the
user's own Pi credentials and models. Zed is its target client.

**Reuse decision (recommended):** keep our architecture (in-process Pi SDK). Running Pi in-process is what lets
the bridge register AIR's proxy providers, and keeps the ACP and Pi layers separate. Port pi-acp's
*translation logic* (MIT, with attribution) into `src/pi` (Pi events -> core `TurnEvent`s) and `src/acp`
(core events -> ACP updates). Don't fork pi-acp: it is one ACP+Pi class with no driver/bridge split, and it
needs a `pi` subprocess and the user's Pi configuration.

## 2. ACP surface: what we have, what's missing

| ACP item | Spec | Junie | pi-acp | pi-junie now | Needed for a normal chat? |
|---|---|---|---|---|---|
| `initialize` | base | ✓ | ✓ | ✓ | — |
| `session/new` | base | ✓ | ✓ | ✓ | — |
| `session/prompt` text | base | ✓ | ✓ | ✓ | — |
| prompt images / embedded resources | base (capabilities) | image ✓ | ✓ | resources as text, **no images** | P1 |
| `session/cancel` | base | ✓ | ✓ | ✓ | — |
| `agent_message_chunk` / `agent_thought_chunk` | base | ✓ | ✓ | ✓ (thoughts never emitted, thinking is `off`) | P1 thinking level |
| `usage_update` | base | ✓ | ✓ | ✓ | — |
| `session_info_update` **title** | base | ✓ after first turn | ✓ | **✗** (AIR shows an untitled chat) | **P0** |
| `config_option_update` model | base | ✓ | ✓ | ✓ | — |
| reasoning **effort** config option | base | ✓ (`effort`) | as `mode` | ✗ | P1 |
| `session/set_config_option` | base | ✓ | ✓ | model only, unknown ids return -32602 | — |
| `session/resume` | unstable | ✓ | — | ✓ (new) | — |
| `session/load` + replay (`user_message_chunk`, ...) | base (`loadSession`) | ✓ | ✓ | ✗ | P1: reopen from history after an IDE restart |
| `session/list` with real sessions | unstable | ✓ (+ AIR meta) | ✓ | returns `[]` | P1: history panel |
| `session/close`, `session/delete` | unstable | ✓ | — | close ✓ | P2 |
| `available_commands_update` (slash commands) | base | ✓ | ✓ | ✗ | P2 |
| `tool_call` / `tool_call_update` | base | ✓ | ✓ | ✗ (no tools) | **P0 for a coding chat**, not for Q&A |
| `session/request_permission` | base (client) | ✓ | for extension UI | ✗ | with tools |
| `plan` | base | ✓ | — | ✗ | P2 |
| `fs/*`, `terminal/*` client delegation | base (client) | ✗ (client says false) | ✗ | ✗ | not needed: AIR sends `fs:false, terminal:false` |
| MCP servers from `session/new` | base | ✓ | stored only | ignored | P2 (AIR's `jetbrains_air_ide` MCP) |
| `authMethods` / `_auth/status_update` | base / AIR | ✓ | terminal auth | none | P2: AIR status label only |

## 3. What "normal conversation" needs, in order

**Plain Q&A already works** (live log: Google BYOK 200, Anthropic via JetBrains AI earlier). To make it feel
like a normal chat:

1. **Title**: emit `session_info_update {title}` after the first turn. Take it from Pi's session name, or
   generate it cheaply: first user line, truncated (pi-acp falls back to this). P0, small.
2. **History across IDE restarts**: return persisted sessions from `session/list` (with `_meta.jetbrains.air`
   lastPromptAt/state like Junie), advertise `loadSession`, implement `session/load` that replays the Pi
   transcript as `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk`. pi-acp's replay can be
   ported. P1, medium.
3. **Thinking / effort**: a `select` config option (`off|low|medium|high`) mapped to Pi `thinkingLevel`, so
   reasoning models think and their thoughts stream as `agent_thought_chunk`. P1, small.
4. **Images in prompts**: advertise `image: true` and pass image blocks to `pi.prompt(text, {images})`. P1, small.
5. **Typed errors**: AIR negotiates `sessionFailure`. Today errors arrive as a markdown chunk; keep that until
   we have the failure contract. P2.

**For a coding chat (the next step after Q&A):**

6. **Tools**: enable Pi's built-in tools (read/bash/edit/write/grep/find/ls) in the bridge session and map the
   events. pi-acp's mapping is the reference: `toolcall_*` deltas -> `tool_call` (pending, `rawInput`,
   `locations`, `kind`); `tool_execution_start/update/end` -> `tool_call_update` (in_progress -> completed or
   failed, text content); bash -> terminal output content; edit/write -> `{type:"diff", path, oldText, newText}`
   from a pre-execution snapshot. New core `TurnEvent`s: `tool_start`, `tool_update`, `tool_end` (neutral shapes).
7. **Permissions**: Pi has no built-in approval. Gate tool calls with a Pi `tool_call` hook (an inline
   extension in the bridge) that asks the client through a core port, `requestPermission(tool, args)`. The
   driver maps it to `session/request_permission` with allow_once / allow_always / reject options. Without
   it, Pi edits files and runs commands unasked.
8. **Context**: load the project's AGENTS.md/CLAUDE.md context files and skills (DefaultResourceLoader with
   `noExtensions`), and use Pi's real coding system prompt instead of our one-line Q&A prompt.

## 4. Pieces of pi-acp worth porting (by function in `dist/index.js`)

| pi-acp function | Purpose | Goes to |
|---|---|---|
| `handlePiEvent` (text/thinking/toolcall/tool_execution_*) | event -> update mapping | `src/pi` (-> TurnEvent) + `src/acp/codec.ts` |
| `toToolKind`, `toToolCallLocations`, `getToolPath`, `findUniqueLineNumber` | tool presentation | `src/pi` (neutral) |
| `bashTerminalContent/OutputMeta`, `bashOutputDelta` | bash as terminal | codec (AIR also has `terminal_output_delta` meta) |
| edit/write snapshot -> diff | diffs | `src/pi` |
| `promptToPiMessage` | ACP prompt blocks -> Pi text + images | `src/acp/codec.ts` (+ images in core) |
| `listPiSessions`, `pickTitleFromTail`, `scanSessionInfoNameFromFile` | session list and titles | `src/pi/session-store.ts` |
| history replay in `session/load` | replay | `src/pi` + codec |
| `loadSlashCommands`, `expandSlashCommand`, built-ins | slash commands | later |

## 5. Observed in the live log (2026-11-17 16:56)

- Discovery against AIR's real proxy works. `/models/user` returns 404 for both the JetBrains AI anthropic and
  openai routes, so the vendor listings are used. Offered: anthropic 15, openai 25 (dated ids such as
  `gpt-4.1-2025-04-14`), google/vertex 9. `[models-todo]` lists the embedding, transcription and newest Gemini
  models.
- `session/resume` failed for a chat created by the previous agent build, which did not persist sessions yet.
  This is expected; new chats persist.
