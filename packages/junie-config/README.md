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
| Custom model profiles (`src/profiles.ts`, `src/profile-provider.ts`): Junie's JSON profiles from the project's `.junie/models` and `$JUNIE_HOME/models` (default `~/.junie/models`), loaded with Junie's rules: file name = profile id, project wins, `primaryModel`/`fasterModel` merged over the top level, `${VAR}` in `apiKey`/`extraHeaders`, Junie's validation messages, one bad file does not stop the others. Each profile is a Pi provider offering its primary model (`custom:<id>` in the bridge's "Custom models" group; `JUNIE_MODEL=custom:<id>` selects it, `defaultEffort` is its effort). Efforts become Pi thinking levels that send the declared name; `extraBody` and `temperature` are added to each request by the extension. Not used yet: `fasterModel` (Junie Cost still picks its own cheap model) and images (text only) | done |
| Step limit (`src/behavior.ts`): `MAX_STEPS` ends a run after that many turns (Junie's steps), recorded as a `junie-exit` entry `{status: "ExitMaxIter"}`; without it Junie's 150 applies when `JUNIE_EXECUTION_MODE` is non-interactive; an interactive chat has no limit | done |
| `ADD_PROJECT_STR=true`: Junie's `## PROJECT STRUCTURE` root listing (same text and skip rules) as the `project_structure` system prompt section | done |
| Tool switches: `SUBAGENTS_ENABLED=false`, `WEB_SEARCH_MODE=disabled/no/false/off`, `FETCH_URL_ENABLED=false` keep those plugin tools inactive | done |
| Request options (`src/request-options.ts`): `PRIMARY_MODEL_TEMPERATURE`, `PRIMARY_MODEL_MAX_TOKENS`, `PRIMARY_MODEL_PARALLEL_TOOL_CALLS=false`, `PRIMARY_MODEL_PROMPT_CACHE_ENABLED=false`, each in the API's own field (Anthropic, OpenAI Responses/Completions, Google); a profile's temperature wins | done |
| Settings with no counterpart in Pi (`PRIMARY_CRITIQUE`, `PRIMARY_MODEL_NUM_CHOICES`, `ALLOW_CALL_EXPERT`, `VERIFY_PROJECT`, `PRIMARY_HISTORY_PROCESSOR`, ...): recorded, and the bridge logs them as having no effect (`APPLIED_SETTINGS` lists what is applied) | done |
| Prompt usage log (`JUNIE_LOG_PROMPT_USAGE=true`, Junie's `--log-prompt-usage`): after each run, one line per new prompt, `prompt=N tokens=T cost=X credits text="..."`, in `<JUNIE_HOME>/logs/log-prompt-<date>-pid-<pid>.log`; the usage maths and Junie's formats are in `src/usage.ts` (also used by the bridge's `/stats` and session cost) | done |
| Retries and the rest of non-interactive mode (`JUNIE_EXECUTION_MODE`) | plan step 6, headless runner |
| `MODEL_MIX_ENABLED` (Eco): `true` / `false` is the starting Eco choice for Eco-capable models without a remembered choice; Eco itself (planning on the selected model, implementing on the account's implementation model) is the bridge's, with junie-cost's planner and router | done |

## Tests

`npm test --workspace pi-junie-config` runs the offline unit tests; the bridge tests it in a session
(`packages/bridge/test/junie-config.test.ts`).
