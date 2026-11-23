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

## Output (extend)

- Report only. Do not edit, commit, stash or reset anything, including "small fixes".
- Do not run `om-setup-agent-pipeline`; the config and the tracker descriptor are committed.
