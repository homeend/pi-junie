# Plan: run pi-junie the way Junie runs on the eval

Status: accepted 2026-11-23, in progress.

Decisions (§7): both targets (eval and local runs); assume the eval may set any of Junie's settings; junie-cost is
copied into this repository (`packages/junie-cost`) and changed here; `junie-config` lives here too. The repository
became an npm workspace like junie-pi (`packages/bridge`, `packages/junie-cost`, next `packages/junie-config`).

Done: workspace layout; junie-cost copied and built into the bridge; step 1 (`junie-config` settings and record); step 2 (keys and model choice; jetbrains-ai copied into `packages/jetbrains-ai`); step 3 (custom model profiles); step 4 (behavior settings, except retries, which come with step 6); step 5 (junie-config is built into the bridge).

## 1. Where we are

**Junie on the eval** runs as its own CLI build in headless mode. TeamCity passes everything through the environment:

| Group | Settings |
| --- | --- |
| Task | `EJ_TASK` / `JUNIE_TASK`; `JUNIE_EXECUTION_MODE` (`NonInteractive`); `SUPPORTS_ASK_QUESTION` |
| Credentials | `EJ_AUTH_USE_DIRECT_ACCESS=true` (hidden option: "classic direct access keys for evaluation"), then `JUNIE_API_KEY` or one key per vendor: `JUNIE_ANTHROPIC_API_KEY`, `JUNIE_OPENAI_API_KEY`, `JUNIE_GROK_API_KEY`, `JUNIE_GOOGLE_API_KEY`, `JUNIE_OPENROUTER_API_KEY`, `JUNIE_LITELLM_URL` + `JUNIE_LITELLM_API_KEY` |
| Self-hosted models | custom model profiles `$JUNIE_HOME/models/<id>.json`: `baseUrl`, `apiKey` (with `${ENV}`), `apiType` (`OpenAICompletion`, `OpenAIResponses`, `Google`, `Anthropic`), `primaryModel` / `fasterModel`, `efforts`, `defaultEffort`, `maxContextLength`, `extraHeaders`, `extraBody` |
| Model | `PRIMARY_MODEL` / `JUNIE_MODEL`, `PRIMARY_MODEL_REASONING_EFFORT` / `JUNIE_EFFORT`, `PRIMARY_MODEL_TEMPERATURE`, `PRIMARY_MODEL_MAX_TOKENS`, `PRIMARY_MODEL_PROMPT_CACHE_ENABLED`, `PRIMARY_MODEL_PARALLEL_TOOL_CALLS` |
| Behavior | `MODEL_MIX_ENABLED` (Eco), `MAX_STEPS`, `ADD_PROJECT_STR` (project tree in the prompt), `PRIMARY_HISTORY_PROCESSOR`, `PRIMARY_MAX_COMMAND_OUTPUT_LINES` / `_LINE_LENGTH`, `SUBAGENTS_ENABLED` / `SUBAGENTS_MODE`, `WEB_SEARCH_MODE`, `FETCH_URL_ENABLED`, `JUNIE_BENCHMARK_RULES`, `JUNIE_GUIDELINES` |
| Results | the resolved values in `agent_info.agent_configuration` of every task |

Sources: `junie-agent` `ej-core/.../util/EjProperties.kt`, `ej-app/cli-standalone/.../utils/Environment.kt`,
`core/.../llm/CustomModel*.kt`, `.teamcity/ci/src/evals/common/RunBuildTypeBuilder.kt`. The SWE-bench harness that
sets the values for each job (`swebench_matterhorn`, `executors/<agent>/linux/{install,run}.sh`) is not available
locally.

**Pi on the eval** is a separate path. `cli-evals.jar` → `PiExecutor`, on `junie-agent` branch
`dsushentsev/add-junie-in-pi-agent`, runs:

```
pi --print --mode json --provider jetbrains-ai --model $MATTERHORN_CLI_AGENT_MODEL --thinking $MATTERHORN_CLI_AGENT_EFFORT
   --append-system-prompt <eval prompt> --session-dir ~/.pi/sessions
   --extension $PI_JUNIE_PI_DIR/packages/jetbrains-ai [--extension $PI_JUNIE_PI_DIR/packages/junie-cost] "<task>"
```

It creates a temporary `PI_CODING_AGENT_DIR` holding:
- `auth.json`, with `JUNIE_API_KEY` stored as a `jetbrains-ai` OAuth credential;
- `settings.json`, with `retry` set to 20 attempts, 5 s base delay and 30 s maximum delay.

Its only other settings are `PI_JUNIE_COST` and `JUNIE_BENCHMARK_RULES`.

**pi-junie** runs none of this. It is an ACP bridge:
- its models come from AIR's proxy (`providers/set`);
- it uses an isolated agent dir and ignores the user's Pi config;
- it has no headless entry point.

Its own agent setup is what the eval would miss today:
- the system prompt built from the client;
- detected plugins (subagents, todo, plan mode, web access, Junie Cost);
- the Junie compatibility layer;
- the Default group (Junie Mixes from Ingrazzio);
- safe commands, with Brave Mode as the opposite.

## 2. Goal

The eval job keeps its Junie shape: the same environment variables, key and model profiles. With that shape,
pi-junie runs the task headless and produces results the harness can already read. Junie and pi-junie runs then
differ only in the agent, and Junie's settings drive Pi.

## 3. Design

Two pieces, both in this repository.

### 3.1 `junie-config`: a Pi plugin

`packages/junie-config`, a normal Pi package. It works in plain `pi` (the existing `PiExecutor` path) and in the
bridge, where it is detected like the other plugins. It translates Junie's configuration into Pi; it is not tied to
the eval:

| Junie | Pi, through the plugin |
| --- | --- |
| `$JUNIE_HOME/models/*.json` profiles | `pi.registerProvider` per profile; `apiType` → Pi `api` (`openai-completions`, `openai-responses`, `google-generative-ai`, `anthropic-messages`); `${ENV}` in `apiKey`/headers; `efforts` → thinking levels; `primaryModel` = model, `fasterModel` = cheap model for Junie Cost |
| `JUNIE_<VENDOR>_API_KEY` | credentials for Pi's built-in providers, set at runtime, never written to `auth.json` |
| `JUNIE_API_KEY` | the `jetbrains-ai` provider from junie-pi |
| `JUNIE_MODEL` / `PRIMARY_MODEL`, `JUNIE_EFFORT` | the session model and thinking level; Junie model ids mapped as pi-junie's catalog already maps them |
| `MAX_STEPS` | count completed turns (`turn_end`) and end the run at the limit, as Junie does |
| `ADD_PROJECT_STR` | a `project_structure` section in the system prompt, in the format of Junie's `AbstractIssueAgentWorker` |
| `SUBAGENTS_ENABLED`, `WEB_SEARCH_MODE`, `FETCH_URL_ENABLED` | which plugin tools are active |
| `PRIMARY_MODEL_TEMPERATURE`, `_MAX_TOKENS`, `_PROMPT_CACHE_ENABLED`, `_PARALLEL_TOOL_CALLS` | request options in `before_provider_request` |
| `agent_configuration` | one `junie-config` custom entry in the session with the resolved values, secrets left out |

The settings with no Pi or plugin counterpart are listed in §6.

### 3.2 `pi-junie run`: a headless entry point for the bridge

`bin/pi-junie-run` runs one task with the same `PiBackend` the ACP side uses. So the eval gets pi-junie's agent:
- its prompt, plugins and Junie compatibility layer;
- its Default group (which models a level uses).

How it works:
- **Input:** the task from `EJ_TASK` / `JUNIE_TASK`, `--task` or stdin. The model settings come from `junie-config`
  (§3.1) instead of `providers/set`.
- **Non-interactive mode** (`JUNIE_EXECUTION_MODE=NonInteractive`):
  - every permission is allowed (Brave Mode);
  - no `ask_user` tool, no welcome message and no plan-mode prompt.
- **Output:** the same JSON event lines as `pi --print --mode json`, so `PiExecutor`'s parser
  (`PiMessages.kt`, `PiUsageParser.kt`) reads the trajectory and cost unchanged. The session goes to
  `--session-dir`.
- **Exit code** like Junie's: 0 when the run ends normally, non-zero on provider or config errors.

### 3.3 Harness changes (outside this repository)

- **`cli-evals`:** `PiExecutor` gets `PI_JUNIE_BRIDGE=true`, which runs `pi-junie-run` instead of `pi`, with the Junie
  env passed through unchanged. Alternatively, a separate `PI_JUNIE` agent in `CliAgent`.
- **`swebench_matterhorn`:** the Pi `install.sh` also installs this repository (`npm ci --ignore-scripts`) and the
  plugins pi-junie detects. The `run.sh` snapshot then needs regenerating.

These are `junie-agent` / harness changes. I can prepare them as patches, but whoever owns the branch has to push
them.

## 4. Eco on our providers

junie-cost's Eco is fixed to the `jetbrains-ai` provider: both the virtual models and the router use it. With vendor
keys or custom profiles, `MODEL_MIX_ENABLED=true` would therefore do nothing. Options:

1. **(chosen, in our copy) Make the router provider-neutral.** Add an option for the provider of the primary and implementation
   models, plus the implementation model ids, so the router works across providers. It is a small change in
   `model-mix/router.ts` and keeps one Eco implementation.
2. Our own Eco in `junie-config`, copying junie-cost's planner. That makes two copies to keep in step.

## 5. Steps (one commit each, tested before the next)

1. **`junie-config` skeleton and settings record.** Parse Junie's settings from the environment, with the same
   names and defaults as `EjProperties`. Write the `junie-config` entry and log the resolved values.
   - Tests: values resolved from the environment; secrets never written.
2. **Credentials and model choice.**
   - `JUNIE_API_KEY` uses jetbrains-ai; `JUNIE_<VENDOR>_API_KEY` uses Pi's built-in providers.
   - `JUNIE_MODEL` / `JUNIE_EFFORT` pick the session model and effort, with Junie ids mapped to Pi models.
   - Tests: against the fake proxy.
3. **Custom model profiles.** Read `$JUNIE_HOME/models/*.json` in Junie's format: `${ENV}`, `primaryModel` /
   `fasterModel` overrides, effort validation.
   - Errors are reported per profile, the way `CustomModelProfileLoader` does.
   - Tests: Junie's own profile examples (LiteLLM, LM Studio docs) as fixtures.
4. **Behavior settings.**
   - `MAX_STEPS`.
   - `ADD_PROJECT_STR`.
   - `SUBAGENTS_ENABLED` / `WEB_SEARCH_MODE` / `FETCH_URL_ENABLED`.
   - Request options (temperature, max tokens, prompt cache, parallel tool calls).
   - Retry policy as in `PiExecutor`: 20 attempts, 5 s base delay, 30 s maximum; Junie's own retries run up to
     1000 × 30 s.
5. **Load `junie-config` in the bridge.** Detected like the other plugins; in AIR it only applies what the user set,
   since AIR still provides the models.
6. **`pi-junie run`.** The headless runner: non-interactive mode, Pi JSON output, exit codes. End-to-end test with the
   fake proxy, checking that the output parses the way `PiExecutor` reads it, using `pi/print-json.jsonl` from
   `cli-evals` tests as the reference.
7. **Eco across providers.** Make the router of our junie-cost copy provider-neutral (§4.1), then map
   `MODEL_MIX_ENABLED` onto it, together with the Default group levels marked `ecoMode`.
8. **Harness patches** (§3.3) for `cli-evals` and the install script, plus a local dry run.
   - The dry run: the eval prompt, one SWE-bench task in a container, pi-junie headless.
   - These patches are handed over, not pushed.
9. **Docs.**
   - Spec section and README for running pi-junie headless.
   - Feature map row.
   - Update this plan to "done".

Steps 1–6 are self-contained and testable here. Step 8 depends on access to the harness branch and an eval run.

## 6. Not covered, on purpose

- `PRIMARY_HISTORY_PROCESSOR` and `PRIMARY_MAX_COMMAND_OUTPUT_*`. junie-cost hard-codes Junie's default limits.
  Matching other values would need options in junie-cost, so this is only worth doing if an eval job changes them.
- `PRIMARY_MODEL_NUM_CHOICES`, `PRIMARY_CRITIQUE`, `ALLOW_CALL_EXPERT`, `VERIFY_PROJECT`: Junie-internal agent
  features with no Pi counterpart. They are logged as ignored.
- Junie's trajectory format. pi-junie produces Pi's JSON events, which the harness already parses for Pi.

## 7. Decisions (2026-11-23)

1. **Target:** both, the eval and local runs with Junie's keys and profiles.
2. **Harness values:** unknown; assume a job may set any of Junie's settings, so `junie-config` handles all of §1.
3. **Eco:** junie-cost is copied into this repository and its router made provider-neutral here.
4. **`junie-config`:** lives in this repository, as `packages/junie-config`.
