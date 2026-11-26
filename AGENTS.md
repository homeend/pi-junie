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
  through a neutral type or port in `core`. The other packages never import the bridge (same test): they must
  work in plain Pi.
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

## Task router

Find every row your task touches (a task can match several) and read its files before you write, audit or review.

| The task | Read first | Key rule |
| --- | --- | --- |
| A new or changed feature | `.agents/skills/new-feature/SKILL.md` | spec first; one type per spec |
| Runs in plain Pi and in AIR, or is not an AIR feature | `.agents/skills/new-feature/references/surfaces.md` | a surface table; a test and a hand check per surface; split specs linked by `Depends on:` |
| Takes, saves or sends a key, password or token | `.agents/skills/new-feature/references/credentials.md` | only Pi's store or AIR's proxy; never in a log or transcript |
| Something an existing plugin or Pi core may already do | `.agents/skills/new-feature/references/reuse-decision.md` | smallest option first, proven from the source |
| Code in `packages/bridge` | `.agents/skills/new-feature/references/bridge-change.md`, `packages/bridge/docs/spec.md` | replay test first; layers |
| A new package in `packages/` | `.agents/skills/new-feature/references/own-plugin.md` | works in plain Pi, no import from the bridge |
| A third-party Pi plugin | `.agents/skills/new-feature/references/adopt-plugin.md`, the `plugin-check` skill | read its source, never run it |
| `packages/junie-cost`, `packages/jetbrains-ai`, or a new copy | `.agents/skills/new-feature/references/copied-package.md` | list every divergence |
| Anything AIR shows | `docs/acp-air-communication.md`, `docs/air-pi-feature-map.md` | advertise only what works |
| A hand test before a merge | `.agents/skills/air-test-handoff/SKILL.md` | AIR and plain Pi, per the spec |

## Process

New work follows `docs/development.md`: a spec in `.ai/specs/` (start with the `new-feature` skill), an audit of
the spec by a second model, implementation on a branch in its own worktree, checks, two reviews, a hand test in
AIR (and in plain Pi when the feature runs there), then a merge by the owner.

- One task, one branch, one worktree. Never work on `main` and never push.
- Never merge into `main` without the owner's explicit OK. Before asking, the branch is merge-ready in its own
  worktree: `main` merged into it, conflicts resolved, `npm run check` and `npm test` passing.
- A reviewer reports and changes nothing. Only the implementer edits a branch.
- There is no issue tracker and there are no pull requests (`.ai/trackers/local.md`). Do not use `gh`.
