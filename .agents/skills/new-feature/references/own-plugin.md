# Checklist: own plugin package

New behaviour as a Pi package in `packages/<name>`, usable in plain Pi and loaded by the bridge.

1. **Why a package and not bridge code.** It belongs in a package when it is agent behaviour that makes sense
   without AIR (for example in a headless run). Presentation of something for AIR belongs in the bridge.
2. **Look for an existing one first.** Search npm for a Pi package that already does it; adopting beats writing
   (`adopt-plugin.md`). Record what was found and why it does not fit.
3. **Package shape**, as the existing ones (`packages/plugin-manager`, `packages/junie-config`):
   - `package.json` with `"pi": { "extensions": ["./src/index.ts"] }`, the keyword `pi-package`, a `check` script
     (`tsc --noEmit -p .`) and, with tests, a `test` script (`vitest run`);
   - `tsconfig.json` extending `../../tsconfig.base.json`;
   - `README.md`: what it does, how to load it in plain Pi (`pi -e ./packages/<name>`), its settings.
4. **Works without the bridge.** No import from `packages/bridge`. A test or a documented manual run in plain Pi.
5. **Works without a terminal UI.** Bridge sessions have none: no dialogs, widgets or key bindings in the core
   path; commands and tools only.
6. **Loading in the bridge.** How the bridge loads it (by path, like Junie Cost and Junie Config) and the switch
   that leaves it out (`PI_AIR_<NAME>=0`).
7. **Docs.** README layout section, `docs/architecture.html` package list if it changes the picture, feature map
   row when an AIR feature depends on it.
