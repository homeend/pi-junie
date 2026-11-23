# pi-junie

Pi as an ACP agent for JetBrains AIR, plus a small Pi extension dev setup.

Docs:
- [docs/overview.html](docs/overview.html): the whole approach in one page (open it in a browser)
- [docs/spec.md](docs/spec.md): design and behaviour, kept current
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

- Log: `.pi-dev/pi-air.log` (override with `PI_AIR_LOG`). Format: `<time> <LEVEL> <scope> <message>`:
  - `pi-junie`: process start, exit, signals, crashes
  - `pi-junie:acp`: one line per ACP request (params, result, duration)
  - `pi-junie:pi`: provider bind/unbind (final baseUrl), sessions, model switches, prompt start/end/error
  - `pi-junie:http`: every LLM HTTP call with status and duration; on failure, the response body
  - `pi-junie:wire`: raw JSON-RPC (`<<` in, `>>` out), secrets redacted. `PI_AIR_WIRE=0` turns it off; `PI_AIR_DEBUG=1` adds debug lines.

  Readable summary: `grep -v ':wire ' .pi-dev/pi-air.log`
- Switches: `PI_AIR_TRUST_PROJECT=0` (no project skills), `PI_AIR_JUNIE_EXECUTE_TOOL=0` (IDE router keeps its
  MCP name instead of Junie's `execute_tool`; see `src/pi/junie-compat.ts`), `PI_AIR_PLUGINS=0` (no plugins),
  `PI_AIR_WELCOME=0` (no welcome message).
- Node binary: taken from `PATH`, otherwise the newest `~/.nvm` Node 24+. Override with `PI_AIR_NODE`.
- Pi state for the bridge is kept apart from your `~/.pi/agent` (in `~/.pi/pi-junie/`), so your own Pi
  logins are never sent to AIR's proxy.

## Layout

```
src/core/     neutral types + ports (no ACP, no Pi)
src/acp/      ACP driver: JSON-RPC, v1 wire types, codec, method dispatch
src/pi/       Pi bridge: provider slots, proxy discovery, Ingrazzio and the Default group, AgentSession per
              ACP session, tools and permissions, plugin adapters
src/compat/   AIR feature <-> Pi plugin requirement registry
src/main.ts   composition root (stdio)
bin/pi-air    launcher used by AIR
test/         replay simulator + fixtures extracted from Junie <-> AIR recordings
```

## Tests and the replay workflow

```bash
npm test                 # vitest: driver, replay (fake backend), Pi bridge replay (fake proxy), boundaries
npm run typecheck
```

New recording (a Junie `acp-messages.jsonl`) to a fixture (redacts headers, tokens and home paths):

```bash
node scripts/extract-fixture.ts acp-examples/<session>/derived/acp-messages.jsonl <name> [--max-prompts N]
```

Then add a test in `test/replay.test.ts` that replays it and asserts the behaviour.
`acp-examples/` holds raw recordings and is git-ignored, because it contains keys.

## Pi extension dev setup (separate)

```bash
./scripts/dev.sh [--clean] [--cwd dir] [--source] [-- pi args]   # pi with ./index.ts loaded, /reload to refresh
```

Edit `index.ts` and run `/reload` inside Pi. Extension API: `../pi/packages/coding-agent/docs/extensions.md`.
