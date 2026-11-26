# Surfaces: where the feature must work

Read in step 2 of the `new-feature` skill, before the reuse decision. pi-junie code runs in more than one place,
and each place has its own UI, its own saved state and its own hand test. A feature that names more than one, or
that is not about AIR at all, is planned per surface.

## The surfaces

| Surface | How it runs | Its UI | Its Pi folder | Hand test |
| --- | --- | --- | --- | --- |
| Plain Pi, interactive | `pi` with our packages (`pi -e ./packages/<name>`) | Pi's terminal: commands, `ctx.ui` dialogs, `/model` | `~/.pi/agent` (user's own) | `scripts/dev.sh cli-test <worktree>` |
| Plain Pi, headless | `pi -p`, `--mode rpc`, eval runs | none: arguments, settings, environment | as above, or the eval's | `scripts/dev.sh cli-test <worktree> -- -p "<prompt>"` |
| AIR | the bridge (`bin/pi-air`) | AIR's own UI, driven by ACP messages; bridge commands; elicitation forms | `~/.pi/pi-junie/agent`, kept apart: from `~/.pi/agent` only the installed plugins are loaded; its `models.json` and logins are not used | `scripts/dev.sh air-test <worktree>` |

Facts that decide a design, with their source:
- **A plugin command has no front end in AIR.** AIR's command list holds `new`, `compact`, the skills and the
  commands the bridge codes itself (`packages/bridge/docs/spec.md`, "Commands"), and the bridge binds extensions
  without a UI (`session.bindExtensions({})` in `packages/bridge/src/pi/backend.ts`), so a plugin's dialogs never
  reach the user there. Whether a typed `/name` still reaches the plugin is not verified. An AIR front end is
  bridge code: a bridge command, an elicitation form, or AIR's own dialog.
- **AIR may already own the UI.** Some AIR dialogs exist and call the agent through a protocol method (for example
  the BYOK provider dialog: `_providers/models`, then `providers/set`, in `docs/acp-air-communication.md`). Then
  the AIR side is implementing that method, not building a UI. Find out whether AIR sends it to pi-junie, not
  only to Junie: from a recording, or from the reference saying so. Until then it is unverified.
- **State does not cross by itself.** Providers, models and logins that plain Pi saves in `~/.pi/agent` the bridge
  does not use, on purpose (`README.md`, Pi state for the bridge; `packages/bridge/src/pi/backend.ts`, the runtime
  is made with `modelsPath: null`). Sharing state between surfaces is a decision, with its reason.

## What to write

1. **Surface table** in the spec: one row per surface the feature must work in, with its UI, where its state is
   saved, and its hand test. A surface the feature leaves out is a row that says "not supported" and why. A
   feature that exists only in AIR (most rows of `docs/air-pi-feature-map.md`) writes one line instead:
   "Surfaces: AIR only".
2. **Requirements tagged by surface.** Each R-number says which surfaces it applies to, e.g. `R3 [CLI, AIR]`.
3. **One type per part.** The parts for different surfaces often need different types (an own plugin for plain
   Pi, a bridge change for AIR). Then there are two specs, plugin first, and both:
   - share one requirements list: it lives in the first spec; the second refers to its R-numbers and adds only
     its own;
   - say `Depends on: <spec path>` under `Status:` in the second spec; it is queued after the first is merged.
     Nothing checks this line (`scripts/feature` does not read it): the `new-feature` skill does, in its step 6.
4. **A hand check per surface**: "Check in plain Pi" and "Check in AIR" sections, each with steps and what should
   be seen.
