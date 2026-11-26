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
| 1 | Start | Call the skill | Lists the requirements, checks what existing Pi plugins cover of them, names the type of change, reads that type's checklist and the code |
| 2 | Questions | Choose the option, answer the questions | Shows the reuse decision and asks what the repository cannot answer, then writes `.ai/specs/<date>-<title>.md` |
| 3 | Audit | Answer what the reviewer leaves to you | Up to three audits by a model from another family (`.ai/review-matrix`); after each, it asks you the findings only you can settle and revises the spec |
| 4 | Approve | Say start, change something, or stop | Shows the spec, the last verdict and the open questions |
| 5 | Implement, check, review | Nothing | Commits the spec on `main` and creates the Cezar task: worktree, implementation (Claude), `npm run check`, `npm test`, a review with fixes, then Opus and Sol each review through Pi and end with a verdict; "changes" from either sends both reports back to the implementer, for at most two rounds |
| 6 | Test by hand | Try it in a new chat with `pi-junie-dev`, and in plain Pi when the spec has a "Check in plain Pi" section | `scripts/dev.sh air-test <worktree>` points the test entry at the worktree; `scripts/dev.sh cli-test <worktree>` runs it in plain Pi |
| 7 | Merge | Say "merge" | The branch is synced with `main` in its worktree, the checks are rerun, then merged; `scripts/feature done <spec>` marks the spec implemented, which lets a spec that depends on it be queued |

**Many features at once.** Point the skill at a document that lists features, for example
`/skill:new-feature docs/acp-air-communication.md`. It lists the document's features against
`docs/air-pi-feature-map.md`, you pick the rows, and a fresh sub-agent drafts a spec for each (two at a time; you can ask for up to 8). Those drafts ask
you nothing and are not audited; their questions wait under "Open questions". Each draft then goes through the
flow above one at a time: call the skill without text and pick it.

**Reuse, alter or build.** Before a feature gets its type, the skill finds out what already exists
(`.agents/skills/new-feature/references/reuse-decision.md`). It writes the feature as numbered requirements,
looks at what Pi core and AIR already do, then for candidate plugins in the feature map and on npm, and has
`plugin-check` read each candidate's source: one row per requirement, covered (with file and line) or a gap. For
the gaps it walks the options from smallest to largest: Pi core or AIR already does it, the plugin's settings, adopt it and let the bridge convert, an add-on package beside it, a change
upstream, a local copy that we alter, our own plugin modelled on it, or build nothing. Each option gets its pros
and cons and what we would own afterwards. A fresh sub-agent attacks the recommendation, and you choose. The
method is taken from Open Mercato's `om-gap-analysis`, `om-eject-and-customize` and `om-brainstorm`.

**Surfaces.** pi-junie runs in plain Pi (interactive and headless) and in AIR, each with its own UI, saved state
and hand test. Before the reuse decision the skill writes a table of the surfaces the feature must work in
(`.agents/skills/new-feature/references/surfaces.md`). When the parts for two surfaces need different types, there
are two specs, plugin first, sharing one requirements list; the second says `Depends on:` and is queued after the
first is merged. A feature that asks the user for a key also follows `references/credentials.md`.

The check is repeated at every stage, as Open Mercato repeats its cross-module check: the `AGENTS.md` task router
sends every agent to these files; the audit (`.ai/skills/om-pre-implement-spec/SKILL.md`) works out the surfaces
from the requirements and blocks a spec that lacks one, is not split, shares state silently or mishandles a key;
the code reviews (`.ai/skills/om-code-review/SKILL.md`) compare the packages a diff touches with the spec's
surface table; `packages/bridge/test/architecture.test.ts` keeps the other packages from importing the bridge.

The four types of change and what each requires are in `.agents/skills/new-feature/references/`: a bridge change,
an adopted Pi plugin, an own plugin package, and a copied package (a change to one of our copies, or a new local
copy of a third-party plugin, recorded with its version and checksum and committed unchanged before our changes).

### The helper script

The skill calls `scripts/feature` for the parts that need another model or Cezar. You can run it yourself:

```bash
scripts/feature list                          # the specs and where each one stands
scripts/feature audit <spec> --writer <id>    # one audit by a model from another family than <id>
scripts/feature queue <spec>                  # approve: commit the spec on main, send it to Cezar
scripts/feature status <spec>                 # where the Cezar task stands: steps, verdicts, next step
scripts/feature wait <spec>                   # block until the task stops, then print the status
scripts/feature fix <spec> [--note <file>]    # send a stopped task back to the implementer with the reviews
scripts/feature reject <spec>                 # mark it rejected; the file stays
scripts/feature done <spec>                   # after the merge: mark it implemented, commit that on main
```

`<spec>` is a path, a file name, or the number from the list. Audits and the writer's replies are in
`.ai/runs/<spec name>/` (not tracked). A spec's state is its `Status:` line: draft, approved, implemented or
rejected. A spec with `Depends on: <spec path>` under that line is refused by `queue` until the named spec is
implemented; `list` shows the link.

### Cezar

```bash
scripts/dev.sh cezar projects add .     # once: register this repository
scripts/dev.sh cezar                    # cockpit at http://127.0.0.1:4321; keep it running
```

`scripts/feature queue` creates a task with the workflow **feature-from-spec** and the spec's path as its text.
Cezar makes the worktree and runs `.ai/cezar/workflows/feature-from-spec.yaml`: prepare the worktree
(`scripts/dev.sh worktree`), then step 5 above, stopping at its review gate. Its Pi steps run `scripts/pi-jbai`:
the development agent.

The second reviews decide what happens next. Each reviewer ends with a verdict: a blocker, or a major the spec
does not waive, is "changes"; only minors and nits is "approve". If either says "changes", the implementer gets
both reports, fixes, the checks run again and both reviewers review again. After two such rounds, or when a
reviewer fails, the task stops with a question to you in the cockpit: accept the branch as it is, or stop the
task. Findings only you can resolve (a recording from AIR, an open decision, a deviation from the spec) are
listed under "For the owner" and do not count for the verdict.

Everything is a file in the task's artifacts (`.ai/cezar/artifacts/<task>/`, "Assets" in the cockpit):
`second-review-opus-<n>.md`, `second-review-sol-<n>.md`, the implementer's `fix-reply-<n>.md` and
`for-the-owner.md`. Without a running Cezar, `queue` commits the approved spec and tells you how to send it
later.

Try Cezar without spending anything: `CEZ_DRY_RUN=1 scripts/dev.sh cezar` uses mock agents.

By hand, without Cezar: make a worktree and a branch, run `scripts/dev.sh worktree` in it, implement there, then
`scripts/dev.sh review .ai/specs/<file>` for the two second reviews.

### Test by hand

```bash
scripts/dev.sh air-test <worktree>              # AIR: the pi-junie-dev entry runs this worktree
scripts/dev.sh cli-test <worktree> [-- pi args] # plain Pi: this worktree's Pi and packages
```

In AIR one build is under test at a time; a chat that is already open keeps the old build, so start a new one.
`cli-test` uses a Pi folder inside the worktree (`.pi-dev/cli-agent`, git-ignored), so your `~/.pi/agent` is
neither read nor changed; delete that folder to start clean. The JetBrains AI key comes from the same env file as
the development agent's.

## What lives where

| Path | What | Tracked |
| --- | --- | --- |
| `AGENTS.md` | Rules every agent reads | yes |
| `.ai/specs/` | One spec per feature | yes |
| `.ai/agentic.config.json`, `.ai/trackers/local.md` | Config for the Open Mercato skills: the checks to run, and "there is no tracker" | yes |
| `.ai/skills/<skill>/SKILL.md` | This repository's additions to an upstream skill (spec writing, spec audit, code review) | yes |
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
and queue commands of `scripts/feature` and the headless second review have been run. One real feature (goal setup)
went through the first, straight-line workflow; its second reviews had no effect there, which is why the workflow
now has verdicts and fix rounds. That version has run with Cezar's mock agents only, on the Claude runner: all
approve, all ask for changes (two rounds, then the question to the owner, approve and reject), mixed verdicts,
and a reviewer that forgets its verdict. Not tried: real Pi reviewers ending with a verdict and writing their
report file.

The flow needs these files on `main`: task worktrees start from `main`.
