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
| Credentials (`src/credentials.ts`): `JUNIE_API_KEY` adds the JetBrains AI model group (Junie's catalog through Ingrazzio, `packages/jetbrains-ai`); `JUNIE_ANTHROPIC_API_KEY`, `JUNIE_OPENAI_API_KEY`, `JUNIE_GOOGLE_API_KEY` bind that vendor's model group to the vendor's API with the key. Grok, Meta, OpenRouter and LiteLLM keys are logged as not supported yet. Keys are read from the environment only, never stored or logged. In AIR, a provider the IDE configures replaces the key binding for that vendor | done (applied by the bridge) |
| Model choice: `JUNIE_MODEL` (else `PRIMARY_MODEL`) and `JUNIE_EFFORT` (else `PRIMARY_MODEL_REASONING_EFFORT`), Junie ids, become a new session's model and effort, before the recommended Default level; an unavailable model is logged and the usual default applies | done (applied by the bridge) |
| Custom model profiles (`$JUNIE_HOME/models/*.json`) | plan step 3 |
| Behavior (`MAX_STEPS`, `ADD_PROJECT_STR`, subagents, web search, request options, retries) | plan step 4 |
| `MODEL_MIX_ENABLED` (Eco) | plan step 7 |

## Tests

`npm test --workspace pi-junie-config` runs the offline unit tests; the bridge tests it in a session
(`packages/bridge/test/junie-config.test.ts`).
