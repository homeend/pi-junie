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
| Cezar, the local task runner, and the skills installer | `.dev-tools/` | `scripts/dev-tools/package-lock.json` |
| The development agent: a copy of pi-junie to work with | `.dev-tools/pi-junie/` | a fixed commit; you move it |
| Its Pi folder with its plugins (subagents, todo, plan mode, web access) | `.dev-tools/pi-agent/` | `scripts/dev-tools/pi-plugins.txt` |

Nothing is installed outside the repository, and your normal Pi folder (`~/.pi/agent`) is never read or written;
`air-test` keeps one link in `~/.local/state/pi-junie/`. Needs Node 22.19+, git, jq and curl;
Claude Code for Cezar's implementation step. The README's "Developing" section has the steps from an empty
machine.

Every npm package comes at a locked version: the repository's through `package-lock.json`, the tools' through
`scripts/dev-tools/package-lock.json`. Both are installed with `npm ci`, so a new release of some dependency
reaches you only when someone updates a lockfile and commits it.

### The development agent

You work on pi-junie with pi-junie, but not with the copy you are changing. There are three, kept apart:

| | What it is | Where | Changes when |
| --- | --- | --- | --- |
| The development agent | pi-junie's Pi with all its packages and plugins; what `scripts/pi-jbai` runs, interactive and headless (audits, reviews, Cezar's Pi steps) | `.dev-tools/pi-junie/` and `.dev-tools/pi-agent/` | you run `scripts/dev.sh agent update` |
| The build under test | the worktree of the feature being tried in AIR (`pi-junie-dev` entry) | a task worktree | `scripts/dev.sh air-test <worktree>` |
| Your installed agent | what you use in AIR every day (`pi-junie` entry) and your normal Pi | wherever you installed it; `~/.pi/agent` | you update it |

The development agent loads Pi and pi-junie's own packages (`packages/*`) from its copy of the repository, and
third-party plugins from its own Pi folder, at the versions in `scripts/dev-tools/pi-plugins.txt`. A change on
`main` or in a worktree does not reach it, so a broken change cannot break the tool you fix it with. After a
feature is merged and you trust it, `scripts/dev.sh agent update` moves the copy to the current `main` (or to a
commit you name), and from then on you work with the new feature. `scripts/dev.sh agent` shows where it stands
and prints an AIR entry (`pi-junie-stable`) for using the same agent in AIR. `scripts/pi-jbai --bare` is plain Pi
with only the JetBrains AI provider, for when the development agent itself is broken.

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

Start the `new-feature` skill in an agent, in the main checkout on `main`:

- Claude Code: `/new-feature <what you want>`
- Pi: `scripts/pi-jbai` (the development agent), then `/skill:new-feature <what you want>`

The model you chose in that agent writes the spec. Without text, the skill lists the specs in `.ai/specs/` and asks
whether to continue one or start something new.

| # | Step | You | The agent |
| --- | --- | --- | --- |
| 1 | Start | Call the skill | Names the type of change, reads that type's checklist and the code |
| 2 | Questions | Answer them | Asks what the repository cannot answer, then writes `.ai/specs/<date>-<title>.md` |
| 3 | Audit | Answer what the reviewer leaves to you | Up to three audits by a model from another family (`.ai/review-matrix`); after each, it asks you the findings only you can settle and revises the spec |
| 4 | Approve | Say start, change something, or stop | Shows the spec, the last verdict and the open questions |
| 5 | Implement, check, review | Nothing | Commits the spec on `main` and creates the Cezar task: worktree, implementation (Claude), `npm run check`, `npm test`, a review with fixes, then Opus and Sol each review through Pi and only report |
| 6 | Test in AIR | Try it in a new chat with `pi-junie-dev` | `scripts/dev.sh air-test <worktree>` points the test entry at the worktree |
| 7 | Merge | Say "merge" | The branch is synced with `main` in its worktree, the checks are rerun, then merged |

The four types of change and what each requires are in `.agents/skills/new-feature/references/`: a bridge change,
an adopted Pi plugin (checked first with the `plugin-check` skill), an own plugin package, a change to a copied
package.

### The helper script

The skill calls `scripts/feature` for the parts that need another model or Cezar. You can run it yourself:

```bash
scripts/feature list                          # the specs and where each one stands
scripts/feature audit <spec> --writer <id>    # one audit by a model from another family than <id>
scripts/feature queue <spec>                  # approve: commit the spec on main, send it to Cezar
scripts/feature reject <spec>                 # mark it rejected; the file stays
```

`<spec>` is a path, a file name, or the number from the list. Audits and the writer's replies are in
`.ai/runs/<spec name>/` (not tracked). A spec's state is its `Status:` line: draft, approved or rejected.

### Cezar

```bash
scripts/dev.sh cezar projects add .     # once: register this repository
scripts/dev.sh cezar                    # cockpit at http://127.0.0.1:4321; keep it running
```

`scripts/feature queue` creates a task with the workflow **feature-from-spec** and the spec's path as its text.
Cezar makes the worktree and runs `.ai/cezar/workflows/feature-from-spec.yaml`: prepare the worktree
(`scripts/dev.sh worktree`), then step 5 above, stopping at its review gate. Its Pi steps run `scripts/pi-jbai`:
the development agent. Without a running Cezar, `queue` commits the approved spec and tells you how to send it
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
| `scripts/feature`, `.ai/review-matrix` | Helper of the `new-feature` skill (audit, queue); which model reviews which | yes |
| `scripts/dev.sh`, `scripts/pi-jbai` | Setup and the commands above; the development agent | yes |
| `scripts/dev-tools/` | Versions of Cezar and the skills installer, with their lockfile; the development agent's plugin list | yes |
| `.ai/runs/` | Audits and writer replies per spec | no |
| `.ai/reviews/` | Audit and review reports | no |
| `.agents/skills/om-*`, `.claude/skills/`, `.dev-tools/` | Installed by `scripts/dev.sh setup` | no |

## Updating the tools

- **Upstream skills:** `DO_NOT_TRACK=1 .dev-tools/node_modules/.bin/skills update -p`, review the diff of `skills-lock.json`, and set
  the same commit as `ref` in `.ai/cezar/config.json`.
- **The development agent:** `scripts/dev.sh agent update` for the code; for a plugin, change its version in
  `scripts/dev-tools/pi-plugins.txt` and run `scripts/dev.sh setup`.
- **Cezar or the skills installer:** change the version in `scripts/dev-tools/package.json`, run
  `npm install --package-lock-only` in that folder, review the diff of its `package-lock.json`, commit both, then
  run `scripts/dev.sh setup`.

## Not tried yet

See section 11 of [agentic-process.html](agentic-process.html). In short: setup, worktree preparation, the audit
and queue commands of `scripts/feature` and the headless second review have been run. Cezar has only run the
workflow with mock agents; a real feature has not gone through it.

The flow needs these files on `main`: task worktrees start from `main`.
