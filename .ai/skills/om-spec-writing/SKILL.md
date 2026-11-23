> **Repo-local override.** Extends the installed `om-spec-writing` with the sections a pi-junie spec needs.

## Context to read (add)

- `AGENTS.md`, then the checklist for this change's type in `.agents/skills/new-feature/references/`.
- `docs/air-pi-feature-map.md` for the feature's row, and `packages/bridge/docs/spec.md` for the bridge's behaviour.
- For anything AIR shows: how Junie does it. Look for a recording in `acp-examples/` (git-ignored, contains keys:
  never quote headers or tokens from it) and for an existing fixture in `packages/bridge/test/fixtures/`.

## Spec sections (add)

Every spec for this repository also has:

- **Type of change**: bridge change, adopted Pi plugin, own plugin package, or change to a copied package.
- **Wire contract**: the ACP messages involved, with the fixture or recording they come from. Say "no recording yet"
  when there is none; then the first task is to make one.
- **Source of behaviour**: Pi core, a Pi plugin (name and version) or bridge code, as in the feature map.
- **First test**: the replay or unit test that is written before the implementation, by file name.
- **Layers touched**: which of `core`, `acp`, `pi`, `compat` change, and that the boundaries in
  `packages/bridge/test/architecture.test.ts` still hold.
- **Check in AIR**: the steps a person does in AIR to see the feature work.
- **Docs to update**: the feature-map row, `packages/bridge/docs/spec.md`, the README when a switch or command is added.

## Questions (extend)

Ask about behaviour, never about facts the code, the fixtures or the docs already answer.
