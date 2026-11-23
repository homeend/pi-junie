# Developing pi-junie with agents

How a feature gets from an idea to `main`, and how to set up the tools for it. Everything runs locally: no issue
tracker, no pull requests, nothing pushed by an agent. The reasoning behind the process is in
[agentic-process.html](agentic-process.html).

To only *use* pi-junie in AIR you need none of this: `npm ci` and `bin/pi-air` are enough (see the README).

## Set up once

```bash
scripts/dev.sh setup      # safe to run again; `scripts/dev.sh check` reports without changing anything
```

It installs into git-ignored folders of this checkout:

| What | Where | Version |
| --- | --- | --- |
| Dependencies, including Pi | `node_modules/` | `package-lock.json` |
| Open Mercato skills: spec writing, spec audit, code review, check-and-commit, troubleshooter, brainstorm | `.agents/skills/om-*` | the commit in `skills-lock.json` |
| Your own review skills (`agent-cross-review` and its siblings), if you have them | links to `~/.claude/skills` | yours |
| Links so Claude Code sees the same skills as Pi | `.claude/skills/` | |
| Cezar, the local task runner | `.dev-tools/` | pinned in `scripts/dev.sh` |

Nothing is installed outside the repository; headless Pi keeps its state in `~/.pi/pi-junie-dev`, and `air-test`
keeps one link in `~/.local/state/pi-junie/`. Needs Node 22.19+, git and jq; Claude Code and gg for the first route
below.

**JetBrains AI key for headless Pi** (spec audits, second reviews, Cezar's Pi steps). Put a Junie API key from
<https://junie.jetbrains.com/cli> into a file outside the repository:

```bash
mkdir -p ~/.config/pi-junie
printf 'JUNIE_API_KEY=%s\n' '<key>' > ~/.config/pi-junie/env && chmod 600 ~/.config/pi-junie/env
```

**AIR entry for builds under test**, once, in `~/.jetbrains/acp.json` next to `pi-junie`. `scripts/dev.sh air-test`
prints the exact line for your machine:

```json
"pi-junie-dev": { "command": "<home>/.local/state/pi-junie/under-test/bin/pi-air", "args": [], "env": {} }
```

## The flow for one feature

| # | Step | You | The agent |
| --- | --- | --- | --- |
| 1 | Start | Run the `new-feature` skill with the item (`/new-feature session instructions` in Claude Code, the `new-feature` command in a pi-junie chat) | Names the type of change, reads that type's checklist, asks its questions |
| 2 | Spec | Answer the questions | Writes `.ai/specs/<date>-<title>.md` |
| 3 | Spec audit | `scripts/dev.sh audit <spec>`, read the audit, then approve the spec or send it back | A second model (Sol) checks the spec against the code; report in `.ai/reviews/` |
| 4 | Implement | Dispatch it (two routes below) | Works on a branch in its own worktree, test first |
| 5 | Checks and first review | Nothing | `npm run check`, `npm test`; Claude reviews against the spec and fixes |
| 6 | Second review | Read the two reports | Opus and Sol each review through Pi and only report |
| 7 | Test in AIR | Try it in a new chat with `pi-junie-dev` | `air-test-handoff` skill: points the test entry at the worktree, lists what to try |
| 8 | Merge | Say "merge" | Syncs the branch with `main` in its worktree, reruns the checks, merges, updates the feature map |

The four types of change and what each requires are in `.agents/skills/new-feature/references/`: a bridge change,
an adopted Pi plugin (checked first with the `plugin-check` skill), an own plugin package, a change to a copied
package.

### Step 4, route A: Claude Code with gg

In Claude Code, in the main checkout: "delegate the spec at `.ai/specs/<file>` to a worker" (your `gg-delegate`
skill). In the worker's worktree, run `scripts/dev.sh worktree` once: it installs dependencies and links the
skills. Steps 5 and 6 are then asked for by hand:

```bash
cd <worktree>
scripts/dev.sh review .ai/specs/<file>     # second review: Opus and Sol, reports in .ai/reviews/
```

### Step 4, route B: Cezar

```bash
scripts/dev.sh cezar projects add .     # once: register this repository
scripts/dev.sh cezar                    # cockpit at http://127.0.0.1:4321
```

Create a task with the workflow **feature-from-spec** and the spec's path as its text. Cezar makes the worktree,
prepares it (`scripts/dev.sh worktree`, through the lifecycle setting in `.ai/cezar/config.json`) and runs steps
4 to 6 from `.ai/cezar/workflows/feature-from-spec.yaml`, stopping at its review gate. Its Pi steps run
`scripts/pi-jbai`: plain Pi on JetBrains AI.

Try Cezar without spending anything: `CEZ_DRY_RUN=1 scripts/dev.sh cezar` uses mock agents.

### Step 7: test in AIR

```bash
scripts/dev.sh air-test <worktree>
```

One build is under test at a time. A chat that is already open keeps the old build; start a new one.

## What lives where

| Path | What | Tracked |
| --- | --- | --- |
| `AGENTS.md` | Rules every agent reads | yes |
| `.ai/specs/` | One spec per feature | yes |
| `.ai/agentic.config.json`, `.ai/trackers/local.md` | Config for the Open Mercato skills: the checks to run, and "there is no tracker" | yes |
| `.ai/skills/<skill>/SKILL.md` | This repository's additions to an upstream skill | yes |
| `.ai/cezar/` | Cezar's project config and the workflow | yes |
| `.agents/skills/new-feature`, `plugin-check`, `air-test-handoff` | This repository's own skills | yes |
| `skills-lock.json` | Which upstream skills, at which commit | yes |
| `scripts/dev.sh`, `scripts/pi-jbai` | Setup and the commands above; Pi on JetBrains AI | yes |
| `.ai/reviews/` | Audit and review reports | no |
| `.agents/skills/om-*`, `.claude/skills/`, `.dev-tools/` | Installed by `scripts/dev.sh setup` | no |

## Updating the tools

- **Upstream skills:** `DO_NOT_TRACK=1 npx skills@1.9.0 update -p`, review the diff of `skills-lock.json`, and set
  the same commit as `ref` in `.ai/cezar/config.json`.
- **Cezar:** change `CEZAR_VERSION` in `scripts/dev.sh` and run `scripts/dev.sh setup`.

## Not tried yet

See section 11 of [agentic-process.html](agentic-process.html). In short: the setup, the worktree preparation, a
headless spec audit and a headless second review have been run; a full feature through Cezar has not.

The flow needs these files on `main`: task worktrees start from `main`.
