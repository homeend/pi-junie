# Credentials: a feature that takes, saves or sends a key

Read in step 2 of the `new-feature` skill when the feature asks the user for an API key, password or token, saves
one, or sends one somewhere. The rule is in `AGENTS.md` ("Secrets"); this is how a spec meets it.

## Where the key lives

Pick one per surface and write it in the spec's surface table:

| Where | When | What pi-junie sees |
| --- | --- | --- |
| AIR's proxy | AIR has its own dialog for the key (BYOK) | after binding, not the key: AIR's proxy adds it upstream and the agent gets a proxy URL and proxy headers (`docs/junie-proxy-triage.md`, auth headers). Before binding, AIR's model probe `_providers/models` carries the endpoint's `headers`, which can hold the key (`docs/acp-air-communication.md`); treat it as a key on the wire |
| Pi's credential store | plain Pi; the user typed the key | Pi's `auth.json` in the Pi folder, written by Pi when a provider extension asks through `auth.apiKey.login` with a secret prompt (Pi's `docs/extensions.md`, provider auth; it then appears in `/login`); or a `models.json` entry with `$VAR` or `!command` in place of the key (Pi's `docs/models.md`) |
| The environment | keys for the bridge, eval and dev tools | read at start, never saved |

Our own file for keys is not on the list. If a feature seems to need one, it is a question for the user.

## Checks the spec must contain

1. **Never in a tracked file**, a fixture or a test. Tests use a fake key such as `test-key` against the fake
   proxy.
2. **Never in a log, a transcript or a session entry.** The bridge's wire log masks values only by their JSON
   field name (`redactSecrets` in `packages/bridge/src/core/log.ts`: names containing key, token, secret,
   authorization, password). A key typed as an elicitation-form answer, as command arguments or in prompt text
   is NOT masked, and it lands in the session transcript. The spec says how the key avoids that path, and a test
   greps the log and the session file for the fake key.
3. **Never in an error message.** A failed request reports the status and the endpoint's host, not the headers.
4. **Removing works.** The user can remove the key again, and the spec says where from.
