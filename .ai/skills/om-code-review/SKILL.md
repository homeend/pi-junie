> **Repo-local override.** Extends the installed `om-code-review` with this repository's review inputs and output.

## Scope (extend)

- The unit of review is the current worktree's branch against `main`:
  `git diff "$(git merge-base main HEAD)"`. There are no pull requests here (see `.ai/trackers/local.md`).
- When a spec path is given, review the diff against that spec: missing acceptance checks and work outside the
  spec's scope are findings.

## Run the checklists (add)

- The rules in `AGENTS.md`, above all the layer boundaries and "a replay test for everything AIR sees".
- A new or changed AIR feature has its row in `docs/air-pi-feature-map.md` and its entry in
  `packages/bridge/src/compat/features.ts` updated in the same change.
- Nothing from `acp-examples/` and no key, token or home path is added to a tracked file.
- **Surfaces.** List the packages the diff touches. A diff in `packages/bridge` and in another package, or in a
  package that plain Pi loads, is a change on more than one surface: read
  `.agents/skills/new-feature/references/surfaces.md`. The spec's surface table must cover every surface the diff
  changes; code for a surface the spec does not name is a finding. Each surface has a test, and a feature in both
  a package and the bridge has one test through the bridge with the package loaded.
- **Keys.** If the diff reads, saves or sends a key, password or token: check it against
  `.agents/skills/new-feature/references/credentials.md` (where it is kept, never in a log, transcript, session
  entry or error message, a test that greps for the fake key).
- A package outside `packages/bridge` does not import the bridge (`packages/bridge/test/architecture.test.ts`),
  and plain Pi's saved state is not read by the bridge unless the spec names that as a decision.

## Output (extend)

- Report only. Do not edit, commit, stash or reset anything, including "small fixes".
- Do not run `om-setup-agent-pipeline`; the config and the tracker descriptor are committed.
