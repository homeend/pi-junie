# OpenAI‑compatible provider: Pi provider + command for safe BYOK and model discovery

Status: approved

Type: Own plugin package

Depends on:

Summary
- Provide a first‑class OpenAI‑compatible BYOK provider in plain Pi, leveraging Pi’s provider system (registerProvider) and a small command to create/update entries in models.json safely. Users supply a base URL (OpenAI‑compatible) and optional Organization; credentials are entered via Pi’s built‑in /login flow (our code never sees or stores secrets). Discovery is implemented in the provider’s refreshModels with strict safety caps (10s timeout, no redirects, 2 MB body cap, ≤500 models). AIR UI is out of scope (mapped later via a bridge spec).

Surfaces (where it must work)
| Surface | How it runs | Its UI | Its Pi folder | Hand test |
| --- | --- | --- | --- | --- |
| Plain Pi, interactive | `pi -e ./packages/byok-openai-compat-provider` (our package loaded) | Providers: a new BYOK provider (registered by id), plus a command `/byok-openai-compat add/remove/refresh` to manage models.json and catalogs; credentials via `/login <providerId>` | `getAgentDir()` | Check in plain Pi (below) |
| Plain Pi, headless | `pi -p` | none: argument/ENV‑driven; discovery uses the last published catalog | same as above (or eval’s) | Check in plain Pi (headless) |
| AIR | bridge (`bin/pi-air`) | none from this spec (plugin dialogs don’t reach AIR) | `~/.pi/pi-junie/agent` | out of scope |

Provider id, naming, collisions
- Default id: `byok-openai-compat-<host-with-dots-replaced-by-dashes>` (e.g. `byok-openai-compat-api-example-test`). For same‑host collisions (different port/path), suffix with `-2`, `-3`, …
- Never use `openai` or another built‑in id. Collisions on explicit `--name` reject with a clear error.

User‑facing workflow
- Create/update: `/byok-openai-compat add <baseUrl> [--name <id>] [--org-env <ENV>] [--key-env <ENV>] [--api responses|completions]`
  - Atomic write to `getAgentDir()/models.json`: keep all other entries; refuse built‑in ids; normalize/merge our entry.
  - Normalization rule (unauthenticated probe): if `<baseUrl>/models` returns 2xx/401/403, persist `<baseUrl>`; if 404/405, try `<baseUrl>/v1/models` and, if it answers (2xx/401/403), persist `<baseUrl>/v1` (avoids later `/chat/completions` mismatches). Otherwise refuse and ask for a full `/v1` URL.
  - Organization goes to `headers.OpenAI-Organization`. If provided via `--org-env NAME`, we persist `$NAME`.
  - API default is `openai-completions`; `openai-responses` allowed via `--api`.
  - After writing, we call `pi.registerProvider(id, config)` in‑process (takes effect immediately). Users then run `/login <id>` to enter the key. We document `/logout <id>` for removal.
- Remove: `/byok-openai-compat remove <id>` removes our models.json entry atomically and calls `pi.unregisterProvider(id)`; the saved catalog file is left to Pi’s cache management. Keys are removed by `/logout <id>` (we do not edit auth.json).

Requirements (P = Provider; C = Credentials; F = File/CLI)
- C1 [Secrets] Our code never accepts an API key argument or writes `auth.json`. Interactive uses `/login <id>`; headless uses `$ENV_VAR`/`!command` in models.json.
- F1 [Models file] Write `getAgentDir()/models.json` atomically (same-directory temp + rename), keep unrelated entries; refuse built‑in ids; detect concurrent edits by double-reading before rename (mtime/contents) and merging once; on a second change, fail with a clear error.
- P1 [Register] `pi.registerProvider(id, { api, headers, authHeader: true, refreshModels, … })` for each of our ids present in models.json; reflect org header and selected API.
- P2 [Discovery] In `refreshModels(context)`: if `!context.allowNetwork`, return `context.stored?.models` for this provider id (or `[]`) and do no network I/O. Otherwise GET `<baseUrl>/models`; if 404/405/empty, try `<baseUrl>/v1/models`. Use Authorization: Bearer from `context.credential.key` (Pi supplied after `/login`); include `OpenAI-Organization` when present. Timeout 10s, redirects disabled, streaming parse with a 2 MB cap.
- P3 [Mapping] Produce ProviderChatModelConfig entries. Defaults when absent from the endpoint:
  - `name = id`, `input = ["text"]`, `cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`, `reasoning = false`;
  - `contextWindow = map(context_length) || 128000`, `maxTokens = Math.min(8192, contextWindow)`.
  - Accept `id`, optional `name`, optional `context_length`; ignore unknowns; do not fabricate vendor capabilities.
- P4 [Publish] Persist the discovered list via `context.publish({ persist: { models: [...], checkedAt: <timestamp> } })` so the last list is saved and used offline and in `pi -p`.
- P5 [Errors] 401/403 → “invalid credentials”; 404 on both `/models` and `/v1/models` → “endpoint not OpenAI‑compatible”; 3xx (any) → error “redirects disallowed”; 5xx/other 4xx → “<host> returned <status>”. Never include headers/body in error text.
- P6 [Caps] If body exceeds 2 MB, abort and error; if >500 models, keep the first 500 and log a one‑line warning to stderr (`console.warn`). Document that headless warnings go to stderr.
- P7 [TLS] No custom TLS; rely on system certs; no insecure fallbacks.

Reuse decision (what exists and why this path)
- Pi core contributes: secure credential flow (`/login`/`/logout`), provider registry (`registerProvider`), offline catalog use (`publish`). We add an OpenAI‑compatible discovery in `refreshModels` and a tiny command to manage models.json safely.
- NPM searches (2026‑11‑26):
  - `npm search --json "keywords:pi-package openai provider"` → none relevant for BYOK + discovery;
  - `npm search --json "pi-package models.json"` → unrelated tooling packages only;
  - `npm search --json "pi-package byok"` → none.
- Challenger (independent attack):
  - OK — Using Pi core for auth and registry is the smallest viable path.
  - WARNING — Hand‑editing models.json remains a parallel path; our command must be careful not to clobber entries (addressed by F1).
  - OK — We do not claim any AIR flow here; bridge mapping is deferred.

Design sketch
- Package: `packages/byok-openai-compat-provider` with one extension entry `src/index.ts`:
  - On load: read `getAgentDir()/models.json`, register every id with prefix `byok-openai-compat-` using `pi.registerProvider(id, { api, headers, authHeader: true, refreshModels })`.
  - Command `/byok-openai-compat add/remove/refresh` to create/update/remove our entries atomically and register/unregister live; refuses built‑in ids/collisions; normalizes baseUrl as per normalization rule; optional `--api`, `--org-env` and `--key-env`.
  - `refreshModels` implements P2–P6, and calls `context.publish` to persist.

Acceptance checks
- A1 (Creation & naming): `/byok-openai-compat add https://example.test/v1` creates `byok-openai-compat-example-test`, persists normalized baseUrl (with `/v1`), registers the provider live, appears in `/model` list. Creation with `--name openai` fails.
- A2 (Auth): `/login byok-openai-compat-example-test` stores the key; a subsequent `/model` refresh shows discovered models; no logs/session contain the fake key (grep check).
- A3 (Discovery/404/401): 401/403 → “invalid credentials”; 404 on both paths → “not OpenAI‑compatible”; 3xx → “redirects disallowed”; errors never show headers/body.
- A4 (Caps): >2 MB body causes a clean error; >500 models trims to 500 and logs a one‑line warning (stderr). Catalog persists via `publish` for offline/headless use.
- A5 (Headless): After creating the entry and setting env, run `/byok-openai-compat refresh <id>` once (interactive or non -p) to publish the catalog; then `pi -p` uses the last published catalog. If `-p` runs before any refresh, no models are available — error documented.
- A6 (Remove): `/byok-openai-compat remove byok-openai-compat-example-test` removes only our entry (others stay) and unregisters the provider; `/logout ...` removes the key.

Credentials (per `credentials.md`)
- Where the key lives: Pi’s auth store (`auth.json`), set via `/login`, never by our code. Headless uses `$ENV_VAR`/`!command` in models.json.
- Checks:
  1) Never in a tracked file — tests use a fake key and a local fake server; no live endpoints.
  2) Never in logs/transcripts — grep for `test-key` in agent logs/session (expected none).
  3) Never in error messages — only host + status class.
  4) Removing — `/logout <id>` documented; our remove command doesn’t touch `auth.json`.

Wire contract
- None (plain Pi only). AIR mapping via `_providers/models` is separate.

Source of behaviour
- Pi core provider system (registerProvider, RefreshModelsContext.credential/publish, `/login`). This package implements only the OpenAI‑compatible probe/mapping and safe models.json management.

Layers touched
- None (no bridge code).

First test
- `packages/byok-openai-provider/test/refresh-models.test.ts` (fake HTTP server, success/401/404/3xx/size/trim)
- `packages/byok-openai-provider/test/command.add-remove.test.ts` (atomic write, keep others, normalize, collisions)

Docs to update
- New package README (usage, safety, limits); mention in docs/architecture.html package list if applicable. Feature‑map row 21 (BYOK) unchanged until the AIR bridge spec lands.

Hand checks — Check in plain Pi
- Interactive
  1. `scripts/dev.sh cli-test <worktree>`
  2. `/byok-openai-compat add <your OpenRouter‑compatible URL>` → confirms created id and normalized baseUrl.
  3. `/login byok-openai-compat-<host>` → paste your key.
  4. `/model` → refresh; select a discovered model; send a short prompt; success.
  5. Inspect the worktree’s Pi folder: models.json has only our entry added; grep logs/session for `test-key` (when using the fake server) → none.
- Headless
  1. Run `/byok-openai-compat add <url> --org-env BYOK_ORG --key-env BYOK_KEY` and export BYOK_KEY/BYOK_ORG env; the entry uses `$BYOK_KEY` automatically.
  2. Run `/byok-openai-compat refresh <id>` once to publish the catalog, then `pi -p` with a short prompt; discovery uses the published catalog; no key in args/logs.

Out of scope
- AIR BYOK dialog or bridge `_providers/models` handler.
- Arbitrary headers; TLS customization.
