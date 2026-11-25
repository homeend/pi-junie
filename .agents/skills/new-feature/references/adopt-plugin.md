# Checklist: adopt an existing Pi plugin

An npm Pi package provides the behaviour; the bridge detects it and maps its state to AIR.

1. **Choose the plugin with the user**, through the reuse decision (`reuse-decision.md`): candidates with
   version, weekly downloads and licence, what each covers of the requirements, and the options for the gaps.
   The choice is the user's. This checklist applies when the plugin runs unchanged (options 1, 2 and 4 there).
2. **The `plugin-check` report** of the chosen package goes into the spec, with its coverage rows. A plugin that
   needs Pi's terminal UI for its core function is not adopted as it is.
   Every gap that stays is named in the spec with what covers it: a plugin setting, a conversion in the bridge
   (say how, and why it is exact), or an upstream request with what we do until it lands.
3. **Detection and loading.** How the bridge finds the package where `pi install npm:<name>` puts it, loads it
   into sessions, and skips it when the user switched it off (`/plugins off`). Follow the existing adapters in
   `packages/bridge/src/pi/` (subagents, todo, plan mode, web access).
4. **Mapping.** Which plugin tools, events or saved entries become which AIR shapes, and which plugin tool rows
   are hidden because AIR shows the feature another way.
5. **Tests.** A small stand-in with the same contract for fast tests, plus an optional test against the real
   package (as `plan-mode.test.ts` and `plan-mode-real.test.ts` do).
6. **Compat registry.** An entry in `packages/bridge/src/compat/features.ts`: the AIR capability is advertised only
   when the plugin is present.
7. **Welcome message and docs.** The new chat's welcome message lists the plugin with its install command; the
   README's plugin list and the feature map's row are updated.
8. **Then the bridge checklist** (`bridge-change.md`) for the mapping code itself.
