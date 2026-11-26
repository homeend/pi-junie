# Checklist: own plugin package

New behaviour as a Pi package in `packages/<name>`, usable in plain Pi and loaded by the bridge.

1. **Why a package and not bridge code.** It belongs in a package when it is agent behaviour that makes sense
   without AIR (for example in a headless run). Presentation of something for AIR belongs in the bridge.
2. **Look for an existing one first**, through the reuse decision (`reuse-decision.md`); adopting beats writing.
   The spec records what was found, what it covers and why the smaller options lost.
   - Modelled on an existing plugin: name it with its version and say what is taken over as an idea (structure,
     tool names, the shape of saved entries) and what differs. No code is copied; copying is `copied-package.md`.
   - Say whether sessions or settings made with the existing plugin should keep working with ours, and what
     happens when the user has both installed.
   - An add-on beside an adopted plugin: name the plugin tools, events or entries it relies on and the version
     they were read from; a test fails when that contract changes.
3. **Package shape**, as the existing ones (`packages/plugin-manager`, `packages/junie-config`):
   - `package.json` with `"pi": { "extensions": ["./src/index.ts"] }`, the keyword `pi-package`, a `check` script
     (`tsc --noEmit -p .`) and, with tests, a `test` script (`vitest run`);
   - `tsconfig.json` extending `../../tsconfig.base.json`;
   - `README.md`: what it does, how to load it in plain Pi (`pi -e ./packages/<name>`), its settings.
4. **Works without the bridge.** No import from `packages/bridge`. A test or a documented manual run in plain Pi.
5. **Works without a terminal UI.** Bridge sessions and headless runs have none, so the core path is commands
   with arguments and tools. A terminal dialog is allowed as plain Pi's front end, only when `ctx.hasUI`, with
   the same action reachable by arguments (as `/plugins` in `packages/plugin-manager/src/index.ts` does). A
   plugin's dialogs never reach AIR: an AIR front end is bridge code, a second spec (`surfaces.md`).
6. **Loading in the bridge.** A package in `packages/` does nothing in AIR by itself. The bridge needs all of
   these, and each is bridge code (a bridge change, so a second spec when this one is plugin-only):
   - the package in the bridge's plugin list (`bundledPlugins` in `packages/bridge/src/main.ts`, by path, like
     Junie Cost and Junie Config) with the switch that leaves it out (`PI_AIR_<NAME>=0`);
   - every tool the plugin registers in the bridge's list of switched-on tools (`pluginTools` in
     `packages/bridge/src/pi/plugins.ts`, used for `tools:` in `backend.ts`). A tool that is not in it is loaded
     and never offered to the model: the log says "plugin … built in" and the tool still does not exist;
   - a test through the bridge that the tool is offered with the package loaded.
   A skill the package's repository keeps in `.agents/skills` is not shipped with the plugin: in AIR a skill
   comes from the open project, from the user's `~/.agents/skills` or from AIR's skill roots, and shows in the
   command list as `$<name>`. A `/command` of the plugin has no front end there (`surfaces.md`).
   Until that bridge part is merged the spec says plainly: "After this spec: plain Pi only; nothing to try in
   AIR" (`surfaces.md`, "What to write", item 3).
7. **Docs.** README layout section, `docs/architecture.html` package list if it changes the picture, feature map
   row when an AIR feature depends on it.
8. **Hand check in plain Pi.** `scripts/dev.sh cli-test <worktree>` runs the worktree's Pi with its packages and
   a Pi folder inside the worktree; the spec's "Check in plain Pi" section gives the steps.
