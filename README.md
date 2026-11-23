# pi-junie

Pi as an ACP agent for JetBrains AIR, and the Pi plugins it uses. An npm workspace: each package lives in
`packages/`, the root is not a Pi package.

Docs:
- [docs/overview.html](docs/overview.html): the whole approach in one page (open it in a browser)
- [packages/bridge/docs/spec.md](packages/bridge/docs/spec.md): design and behaviour of the bridge, kept current
- [docs/eval-parity-plan.md](docs/eval-parity-plan.md): plan to run pi-junie headless with Junie's eval configuration (proposal)
- [docs/air-pi-feature-map.md](docs/air-pi-feature-map.md): each AIR feature, and whether Pi core, a Pi plugin or the bridge provides it
- [docs/junie-proxy-triage.md](docs/junie-proxy-triage.md): how Junie calls LLMs through AIR's proxy
- [docs/gap-analysis.md](docs/gap-analysis.md): the first gap analysis (2026-11-17 snapshot)

## Pi in AIR

The agent is registered in `~/.jetbrains/acp.json` as `pi-junie`. A backup of the original file is at
`~/.jetbrains/acp.json.bak-pi-junie`.

```json
"pi-junie": { "command": "<repo>/bin/pi-air", "args": [], "env": {} }
```

Pick **pi-junie** in AIR. AIR configures its proxy through `providers/set`. The model picker then shows Junie's
Default group (Lite / Normal / Hard / Frontier) and the models discovered for the anthropic, openai, google and
ingrazzio (Junie Lite) slots. Each chat is a full Pi coding session: tools gated by Brave Mode, client MCP servers,
skills and commands, sessions that can be listed, reopened and resumed, and the AIR features in the docs.

Optional Pi plugins add features. Install them with Pi itself, then restart the agent; the welcome message of a
new chat says which ones were found:

```bash
pi install npm:@tintinweb/pi-subagents   # subagents as AIR child sessions
pi install npm:@juicesharp/rpiv-todo     # todo list as AIR's plan / Todo dock
pi install npm:@narumitw/pi-plan-mode    # plan mode with Junie's plan review
pi install npm:pi-web-access             # web search and fetch
```

Built in, no install: Junie Cost (`packages/junie-cost`, a copy of junie-pi's package). It cuts long tool output
(with a cheap-model summary of big `bash` output and the full log next to the session), thins old tool results when
that beats re-caching the prompt, builds `/compact` summaries from a task journal, and fixes millisecond `bash`
timeouts. Its Eco mode still needs Pi's `jetbrains-ai` provider, which bridge sessions do not have, so it stays off
for now. `PI_AIR_JUNIE_COST=0` leaves it out.

- Log: `.pi-dev/pi-air.log` (override with `PI_AIR_LOG`). Format: `<time> <LEVEL> <scope> <message>`:
  - `pi-junie`: process start, exit, signals, crashes
  - `pi-junie:acp`: one line per ACP request (params, result, duration)
  - `pi-junie:pi`: provider bind/unbind (final baseUrl), sessions, model switches, prompt start/end/error
  - `pi-junie:http`: every LLM HTTP call with status and duration; on failure, the response body
  - `pi-junie:wire`: raw JSON-RPC (`<<` in, `>>` out), secrets redacted. `PI_AIR_WIRE=0` turns it off; `PI_AIR_DEBUG=1` adds debug lines.

  Readable summary: `grep -v ':wire ' .pi-dev/pi-air.log`
- Switches: `PI_AIR_TRUST_PROJECT=0` (no project skills), `PI_AIR_JUNIE_EXECUTE_TOOL=0` (IDE router keeps its
  MCP name instead of Junie's `execute_tool`; see `packages/bridge/src/pi/junie-compat.ts`), `PI_AIR_PLUGINS=0` (no plugins),
  `PI_AIR_WELCOME=0` (no welcome message), `PI_AIR_JUNIE_COST=0` (no Junie Cost).
- Junie's keys, set in the `env` of the `acp.json` entry or the environment: `JUNIE_API_KEY` adds a JetBrains AI
  model group; `JUNIE_ANTHROPIC_API_KEY` / `JUNIE_OPENAI_API_KEY` / `JUNIE_GOOGLE_API_KEY` give that vendor's models
  without AIR; `JUNIE_MODEL` / `JUNIE_EFFORT` pick new chats' model. Junie's custom model profiles (`~/.junie/models/*.json`)
  appear as "Custom models" (`JUNIE_MODEL=custom:<profile>`). See `packages/junie-config/README.md`.
- `/stats` (or `/usage`, `/cost`, `/credits`) in a chat: tokens and cost (credits = USD) per model and per prompt,
  as in Junie. AIR shows the chat's total cost on its session row.
- Node binary: taken from `PATH`, otherwise the newest `~/.nvm` Node 24+. Override with `PI_AIR_NODE`.
- Pi state for the bridge is kept apart from your `~/.pi/agent` (in `~/.pi/pi-junie/`), so your own Pi
  logins are never sent to AIR's proxy.

## Layout

```
bin/pi-air                 launcher used by AIR (runs packages/bridge/src/main.ts)
docs/                      docs about the whole project (overview, AIR feature map, proxy triage, plans)
packages/bridge/           pi-junie, the ACP bridge (package "pi-junie")
  src/core/                neutral types + ports (no ACP, no Pi)
  src/acp/                 ACP driver: JSON-RPC, v1 wire types, codec, method dispatch
  src/pi/                  Pi bridge: provider slots, proxy discovery, Ingrazzio and the Default group,
                           AgentSession per ACP session, tools and permissions, plugin adapters
  src/compat/              AIR feature <-> Pi plugin requirement registry
  src/main.ts              composition root (stdio)
  test/                    replay simulator + fixtures extracted from Junie <-> AIR recordings
  scripts/                 fixture extraction
  docs/spec.md             the bridge's spec
packages/junie-cost/       Junie Cost, built-in plugin (copy of junie-pi's package, adapted here)
packages/junie-config/     Junie Config, built-in plugin: Junie's settings, keys and model profiles applied to Pi
packages/jetbrains-ai/     JetBrains AI provider (copy of junie-pi's package), used with JUNIE_API_KEY
```

## Tests and the replay workflow

```bash
npm install --ignore-scripts
npm run check            # types in all packages
npm test                 # all packages; the bridge: driver, replay (fake backend), Pi bridge (fake proxy), boundaries
npm test --workspace pi-junie   # one package
```

New recording (a Junie `acp-messages.jsonl`) to a fixture (redacts headers, tokens and home paths):

```bash
node packages/bridge/scripts/extract-fixture.ts acp-examples/<session>/derived/acp-messages.jsonl <name> [--max-prompts N]
```

Then add a test in `packages/bridge/test/replay.test.ts` that replays it and asserts the behaviour.
`acp-examples/` holds raw recordings and is git-ignored, because it contains keys.
