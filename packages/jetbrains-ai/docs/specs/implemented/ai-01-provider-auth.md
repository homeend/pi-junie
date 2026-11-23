---
id: AI-01
title: JetBrains AI provider and login
package: jetbrains-ai
status: implemented
pi: 1.5.2
depends: []
code: [packages/jetbrains-ai/src/index.ts, packages/jetbrains-ai/src/provider.ts, packages/jetbrains-ai/src/oauth.ts, packages/jetbrains-ai/src/callback-server.ts, packages/jetbrains-ai/src/api-key.ts]
tests: [packages/jetbrains-ai/test/provider.integration.test.ts]
research: []
manual: [R2, R3, R4, R5, R7]
---

# AI-01. JetBrains AI provider and login

## Goal

A Pi user gets access to JetBrains AI models the same way as in Junie CLI: via browser login or a Junie API key, with no changes to the Pi core.

## Behavior

- **R1.** The extension registers a provider in Pi with id `jetbrains-ai` and name `JetBrains`. Requests go to `https://ingrazzio-cloud-prod.labs.jb.gg/v1` with the `X-Keep-Path: true` header. The extension has no other registrations (tools, commands, hooks).
- **R2.** `/login` → **JetBrains** starts the PKCE login of the `junie-cli` client: it opens `https://junie.jetbrains.com/cli-auth?…` with scope `offline_access openid jb-authn-service`, `state`, and `code_challenge` (S256).
- **R3.** The callback is received by a loopback server on `localhost`. The extension tries ports 62345–62364 in order and skips busy ones (`EADDRINUSE`). It waits for the callback for up to 5 minutes. `redirect_uri` is passed without a trailing `/`, as Junie registered it.
- **R4.** If all ports are busy, the user pastes the authorization code manually. Both a raw code and base64 JSON with a `code` field are accepted; the exchange uses `redirect_uri` `https://account.jetbrains.com/oauth2/ide/callback`.
- **R5.** After the code exchange, Pi stores the credentials in its `auth.json`. The OIDC `id_token` serves as the access token and is sent as `Authorization: Bearer <id_token>`. Expiry is computed with a 60 s margin; refresh uses `refresh_token`. A token server response without `id_token` or with an invalid `expires_in` is an error.
- **R6.** Instead of browser login, a Junie API key (https://junie.jetbrains.com/cli) can be supplied: save it via `/login` → **JetBrains** → **Junie API key** or set it in the `JUNIE_API_KEY` variable. A saved key takes precedence over the environment variable.
- **R7.** If `JUNIE_API_KEY` is set, it takes precedence over a saved browser login, as in Junie.
- **R8.** Junie API keys are sent as `Authorization: Bearer <key>`, and GitHub tokens (`ghp_…`, `github_pat_…`) as `Authorization: GitHub <token>`.

## Out of scope

- License activation, quota display, enterprise and JCP authentication.
- A separate OAuth application registration: the extension uses the public `junie-cli` client and JetBrains production endpoints.
- Browser login on another machine: Pi and the browser must run on the same computer.

## Compatibility

Only public API is used: `pi.registerProvider(createProvider(...))` from `@earendil-works/pi-ai` and the standard `auth.apiKey` and `auth.oauth` mechanisms. Pi internals are not patched. If another extension registers a provider with the same id `jetbrains-ai`, they conflict, and Pi decides whose provider remains.

## Settings

- `JUNIE_API_KEY` — Junie API key.
- `/login` → **JetBrains**: browser login or key entry.

## Verification

- The live test `provider.integration.test.ts` verifies R1, R6, and R8: one request through Pi with `JUNIE_API_KEY` to the `gpt-6-luna` model. It needs Pi in `PATH`, network, and a key; the test consumes quota.
- R2–R5 and R7 are verified manually via `/login` in a live Pi: automated tests have no interactive login.
