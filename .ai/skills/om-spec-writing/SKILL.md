> **Repo-local override.** Extends the installed `om-spec-writing` with the sections a pi-junie spec needs.

## Context to read (add)

- `AGENTS.md`, then the checklist for this change's type in `.agents/skills/new-feature/references/`.
- `docs/air-pi-feature-map.md` for the feature's row, and `packages/bridge/docs/spec.md` for the bridge's behaviour.
- For anything AIR shows: how Junie does it. Look for a recording in `acp-examples/` (git-ignored, contains keys:
  never quote headers or tokens from it) and for an existing fixture in `packages/bridge/test/fixtures/`.

## Spec sections (add)

Every spec for this repository also has:

- **Type of change**: bridge change, adopted Pi plugin, own plugin package, or copied package (a change to a copy, or a new copy).
- **Surfaces**: the table from `.agents/skills/new-feature/references/surfaces.md`: each surface (plain Pi
  interactive, plain Pi headless, AIR) with its UI, where its state is saved and its hand test, or "not
  supported" and why; for a feature that exists only in AIR, the one line "Surfaces: AIR only". Requirements carry their surfaces, e.g. `R3 [CLI, AIR]`. The second of two split specs has
  `Depends on: <spec path>` under `Status:` and uses the first spec's R-numbers.
- **Credentials** (when the feature takes, saves or sends a key): where the key lives per surface and the checks
  of `.agents/skills/new-feature/references/credentials.md`.
- **Wire contract**: the ACP messages involved, with the fixture or recording they come from. Say "no recording yet"
  when there is none; then the first task is to make one.
- **Reuse decision**: the requirements, the candidate plugins, what each covers according to its source, the
  options with the reason each was rejected or chosen, what we take on, and the user's decision
  (`.agents/skills/new-feature/references/reuse-decision.md`). For a change that only concerns how the bridge
  presents something: one line saying so.
- **Source of behaviour**: Pi core, a Pi plugin (name and version) or bridge code, as in the feature map.
- **First test**: the replay or unit test that is written before the implementation, by file name.
- **Layers touched**: which of `core`, `acp`, `pi`, `compat` change, and that the boundaries in
  `packages/bridge/test/architecture.test.ts` still hold.
- **Check in AIR** and **Check in plain Pi**: for each surface in the table, the steps a person does to see the
  feature work (`scripts/dev.sh air-test` / `scripts/dev.sh cli-test`). A surface the feature does not support
  needs no section.
- **Docs to update**: the feature-map row, `packages/bridge/docs/spec.md`, the README when a switch or command is added.

## Questions (extend)

Ask about behaviour, never about facts the code, the fixtures or the docs already answer.
