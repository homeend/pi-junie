# pi-junie: instructions for agents

Pi as an ACP agent for JetBrains AIR, plus the Pi plugins it uses. An npm workspace; read `README.md` for the
layout and `packages/bridge/docs/spec.md` for the bridge's behaviour.

## Commands

```bash
npm ci            # once per checkout or worktree
npm run check     # type check, all packages
npm test          # all packages; no network, no keys, no live model
```

Both must pass before a change is called done. Node 22.19 or newer.

## Rules

- **Layer boundaries** in `packages/bridge/src`, enforced by `test/architecture.test.ts`: `core` imports only
  itself; `acp` never imports Pi; `pi` never imports ACP; `compat` is standalone. Something that must cross goes
  through a neutral type or port in `core`.
- **Test first, from the wire.** Whatever AIR sees is covered by a replay test built from a Junie ↔ AIR recording
  (`packages/bridge/scripts/extract-fixture.ts` makes the fixture). Model calls in tests go to the fake proxy.
- **Adopt before writing.** Behaviour comes from Pi core, then from an existing Pi plugin, then from bridge code.
  A plugin that fits only partly goes through `.agents/skills/new-feature/references/reuse-decision.md`.
  `docs/air-pi-feature-map.md` records the choice per feature; keep its row current in the same change.
- **AIR is told only what works.** A capability is advertised through `packages/bridge/src/compat/features.ts`
  when its implementation (and plugin, if any) is present.
- **Copied packages** (`packages/junie-cost`, `packages/jetbrains-ai`) come from junie-pi. List every divergence in
  the note at the top of the package's README.
- **Secrets.** `acp-examples/` holds raw recordings with keys and is git-ignored: never commit it, never quote
  headers or tokens from it. No key, token or home path in a tracked file. The repository, its tests and its dev
  tools read keys from the environment only. A feature that asks the user for a key keeps it only in Pi's own
  credential store (`auth.json`, or `models.json` with `$VAR` / `!command`) or leaves it to AIR's proxy; never in
  a file of ours, a log or a transcript (`.agents/skills/new-feature/references/credentials.md`).
- **Docs are plain.** Say what was checked and what was not.

## Process

New work follows `docs/development.md`: a spec in `.ai/specs/` (start with the `new-feature` skill), an audit of
the spec by a second model, implementation on a branch in its own worktree, checks, two reviews, a hand test in
AIR (and in plain Pi when the feature runs there), then a merge by the owner.

- One task, one branch, one worktree. Never work on `main` and never push.
- Never merge into `main` without the owner's explicit OK. Before asking, the branch is merge-ready in its own
  worktree: `main` merged into it, conflicts resolved, `npm run check` and `npm test` passing.
- A reviewer reports and changes nothing. Only the implementer edits a branch.
- There is no issue tracker and there are no pull requests (`.ai/trackers/local.md`). Do not use `gh`.
