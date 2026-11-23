# Checklist: adopt an existing Pi plugin

An npm Pi package provides the behaviour; the bridge detects it and maps its state to AIR.

1. **Choose the plugin with the user.** List the candidates from `docs/air-pi-feature-map.md` (or npm) with
   version, weekly downloads and licence. The choice is the user's.
2. **Run the `plugin-check` skill** on the chosen package before the spec is written. Its report goes into the
   spec. A plugin that needs Pi's terminal UI for its core function is not adopted as it is.
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
