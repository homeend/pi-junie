# pi-junie

Pi as an ACP agent for JetBrains AIR, plus a small Pi extension dev setup.
Design: [docs/spec.md](docs/spec.md).

## Pi in AIR

The agent is registered in `~/.jetbrains/acp.json` as `pi-junie`. A backup of the original file is at
`~/.jetbrains/acp.json.bak-pi-junie`.

```json
"pi-junie": { "command": "<repo>/bin/pi-air", "args": [], "env": {} }
```

Pick **pi-junie** in AIR. AIR configures its proxy through `providers/set`, and the model picker then lists
Pi's models for the anthropic, openai and google slots. You can chat with the selected model. Tools are off.

- Log: `.pi-dev/pi-air.log` (override with `PI_AIR_LOG`). Format: `<time> <LEVEL> <scope> <message>`:
  - `pi-junie`: process start, exit, signals, crashes
  - `pi-junie:acp`: one line per ACP request (params, result, duration)
  - `pi-junie:pi`: provider bind/unbind (final baseUrl), sessions, model switches, prompt start/end/error
  - `pi-junie:http`: every LLM HTTP call with status and duration; on failure, the response body
  - `pi-junie:wire`: raw JSON-RPC (`<<` in, `>>` out), secrets redacted. `PI_AIR_WIRE=0` turns it off; `PI_AIR_DEBUG=1` adds debug lines.

  Readable summary: `grep -v ':wire ' .pi-dev/pi-air.log`
- Switches: `PI_AIR_TRUST_PROJECT=0` (no project skills), `PI_AIR_JUNIE_EXECUTE_TOOL=0` (IDE router keeps its
  MCP name instead of Junie's `execute_tool`; see `src/pi/junie-compat.ts`).
- Node binary: taken from `PATH`, otherwise the newest `~/.nvm` Node 24+. Override with `PI_AIR_NODE`.
- Pi state for the bridge is kept apart from your `~/.pi/agent` (in `~/.pi/pi-junie/`), so your own Pi
  logins are never sent to AIR's proxy.

## Layout

```
src/core/     neutral types + ports (no ACP, no Pi)
src/acp/      ACP driver: JSON-RPC, v1 wire types, codec, method dispatch
src/pi/       Pi bridge: provider slots, curated models, AgentSession per ACP session
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
