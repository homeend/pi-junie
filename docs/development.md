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
keeps one link in `~/.local/state/pi-junie/`. Needs Node 22.19+, git, jq and curl;
Claude Code for Cezar's implementation step.

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

```bash
scripts/feature           # list the specs, or start a new feature
```

One script takes a feature from an idea to a task in Cezar's queue. You decide three times: approve the spec, try
the result in AIR, say "merge".

| # | Step | You | Done for you |
| --- | --- | --- | --- |
| 1 | Start | `scripts/feature new "<item>"`, pick the model that writes the spec | The reviewer is chosen from another model family (`.ai/review-matrix`); you can change it |
| 2 | Spec | Nothing | The writer (headless Pi, `new-feature` skill) writes `.ai/specs/<date>-<title>.md` |
| 3 | Audit | Nothing | Up to three rounds: the reviewer audits the spec against the code, the writer revises, until the reviewer approves |
| 4 | Decide | Read the spec in your editor, then: approve, audit again, reject, or leave it | Approve commits the spec on `main` and sends it to Cezar |
| 5 | Implement, check, review | Nothing | Cezar: worktree, implementation (Claude), `npm run check`, `npm test`, a review with fixes, then Opus and Sol each review through Pi and only report |
| 6 | Test in AIR | Try it in a new chat with `pi-junie-dev` | `scripts/dev.sh air-test <worktree>` points the test entry at the worktree |
| 7 | Merge | Say "merge" | The branch is synced with `main` in its worktree, the checks are rerun, then merged |

The writer runs unattended and cannot ask you anything. What it cannot settle from the repository goes under
"Open questions" in the spec; what only you can do (for example a recording of AIR with Junie) becomes the spec's
first task. Read those before you approve.

The four types of change and what each requires are in `.agents/skills/new-feature/references/`: a bridge change,
an adopted Pi plugin (checked first with the `plugin-check` skill), an own plugin package, a change to a copied
package.

### The script

```bash
scripts/feature                   # the list; pick a spec by number, or n for a new feature
scripts/feature new "<item>"      # steps 1 to 4
scripts/feature review <spec>     # audit an existing spec again
scripts/feature queue <spec>      # approve it: commit on main, send to Cezar
scripts/feature reject <spec>     # mark it rejected; the file stays
```

`<spec>` is a path, a file name, or the number from the list. For a run without questions:
`scripts/feature new "<item>" --model <id> --reviewer <id> --rounds 3 --then queue` (`--then` also takes `leave` and
`reject`). The audits and the writer's replies are in `.ai/runs/<spec name>/` (not tracked). A spec's state is its
`Status:` line: draft, approved or rejected.

The same skill works in a chat if you want to answer the questions yourself: `/new-feature <item>` in Claude Code,
`/skill:new-feature <item>` in Pi. The spec then shows up in `scripts/feature` like any other.

### Cezar

```bash
scripts/dev.sh cezar projects add .     # once: register this repository
scripts/dev.sh cezar                    # cockpit at http://127.0.0.1:4321; keep it running
```

`scripts/feature queue` creates a task with the workflow **feature-from-spec** and the spec's path as its text.
Cezar makes the worktree and runs `.ai/cezar/workflows/feature-from-spec.yaml`: prepare the worktree
(`scripts/dev.sh worktree`), then step 5 above, stopping at its review gate. Its Pi steps run `scripts/pi-jbai`:
plain Pi on JetBrains AI. Without a running Cezar, `queue` commits the approved spec and tells you how to send it
later.

Try Cezar without spending anything: `CEZ_DRY_RUN=1 scripts/dev.sh cezar` uses mock agents.

By hand, without Cezar: make a worktree and a branch, run `scripts/dev.sh worktree` in it, implement there, then
`scripts/dev.sh review .ai/specs/<file>` for the two second reviews.

### Test in AIR

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
| `scripts/feature`, `.ai/review-matrix` | The feature script; which model reviews which | yes |
| `scripts/dev.sh`, `scripts/pi-jbai` | Setup and the commands above; Pi on JetBrains AI | yes |
| `.ai/runs/` | Audits and writer replies per spec | no |
| `.ai/reviews/` | Audit and review reports | no |
| `.agents/skills/om-*`, `.claude/skills/`, `.dev-tools/` | Installed by `scripts/dev.sh setup` | no |

## Updating the tools

- **Upstream skills:** `DO_NOT_TRACK=1 npx skills@1.9.0 update -p`, review the diff of `skills-lock.json`, and set
  the same commit as `ref` in `.ai/cezar/config.json`.
- **Cezar:** change `CEZAR_VERSION` in `scripts/dev.sh` and run `scripts/dev.sh setup`.

## Not tried yet

See section 11 of [agentic-process.html](agentic-process.html). In short: setup, worktree preparation, the feature
script (spec, audit rounds, approve and queue) and the headless second review have been run. Cezar has only run the
workflow with mock agents; a real feature has not gone through it.

The flow needs these files on `main`: task worktrees start from `main`.
