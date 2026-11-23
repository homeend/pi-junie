# Junie Config

Runs Pi with Junie's configuration: the same environment variables, keys and model profiles that Junie reads, so a
run can be configured as Junie is on the eval or on a developer's machine. The plan and the order of the work are in
[docs/eval-parity-plan.md](../../docs/eval-parity-plan.md).

A plain Pi extension: `pi -e ./packages/junie-config`, or built into pi-junie (the bridge loads it into every session).
Without Junie settings in the environment it does nothing.

## Settings

`src/settings.ts` lists Junie's settings with Junie's property names, environment variables and defaults, copied
from Junie's sources (`EjProperties.kt`, `Environment.kt`). A variable that is set wins, even when empty; otherwise
Junie's default applies. This is the same rule Junie follows.

| What | Status |
| --- | --- |
| Record: a `junie-config` custom entry with every resolved value (credentials as `<set>`), once per session, only when the environment sets a Junie setting. It is Junie's `agent_configuration` for Pi; the model never sees it | done |
| Log: the bridge logs the settings the environment set at startup (`Junie settings from the environment: ...`) | done |
| Credentials (`JUNIE_API_KEY`, `JUNIE_<VENDOR>_API_KEY`) and model choice (`JUNIE_MODEL`, `JUNIE_EFFORT`, `PRIMARY_MODEL*`) | plan step 2 |
| Custom model profiles (`$JUNIE_HOME/models/*.json`) | plan step 3 |
| Behavior (`MAX_STEPS`, `ADD_PROJECT_STR`, subagents, web search, request options, retries) | plan step 4 |
| `MODEL_MIX_ENABLED` (Eco) | plan step 7 |

## Tests

`npm test --workspace pi-junie-config` runs the offline unit tests; the bridge tests it in a session
(`packages/bridge/test/junie-config.test.ts`).
