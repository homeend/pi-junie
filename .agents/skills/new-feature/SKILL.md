---
name: new-feature
description: Use when the user wants to add or change a feature of pi-junie, or to continue one, e.g. "new feature", "add goal mode", "support plugin X", "change the bridge so that…", or the skill called with no text. Runs the whole start of the process in this chat - questions to the user, the spec, up to three audits by a model from another family, the user's approval - and then starts the task in Cezar.
---

# New feature

The entry point of this repository's development process (`docs/development.md`). You are the writer: you talk
to the user, write the spec and revise it. A second model audits it. The skill ends when the task is in Cezar's
queue, or when the user stops it.

`scripts/feature` does the parts that need another model or Cezar. Its commands can take minutes: give them a
time limit of at least ten minutes, or run them in the background and wait.

## 1. What to work on

- **Called with text:** that text is the item. Go to step 2.
- **Called without text:** run `scripts/feature list`.
  - If it lists specs that are not `rejected` and not queued, show them and ask whether to continue one of them
    or start something new. Continuing a spec goes to step 4 (or step 6 if its last audit says APPROVED).
  - Otherwise ask what the user wants to build. If they have no item, offer the open rows of
    `docs/air-pi-feature-map.md`.

## 2. Understand and classify

Read `AGENTS.md`. Find the feature in `docs/air-pi-feature-map.md` (its row says whether Pi core, a Pi plugin or
the bridge provides it) and in `docs/eval-parity-plan.md` if it concerns headless or eval runs.

Classify the change into exactly one type and say which and why. A feature that needs two types is split into
two specs, plugin first.

| Type | It is this when | Checklist |
| --- | --- | --- |
| Bridge change | the work is in `packages/bridge` and no new plugin is involved | `references/bridge-change.md` |
| Adopted Pi plugin | an existing npm Pi package provides the behaviour and the bridge maps it to AIR | `references/adopt-plugin.md` |
| Own plugin package | new behaviour that should also work in plain Pi, as a package in `packages/` | `references/own-plugin.md` |
| Copied package | a change inside `packages/junie-cost` or `packages/jetbrains-ai` | `references/copied-package.md` |

Read that checklist and collect what it asks for from the repository (recordings, fixtures, plugin source,
upstream state).

## 3. Ask, then write the spec

Ask the user what the repository cannot answer: scope, behaviour where there is a choice, what is out of scope,
anything the checklist says to ask. Ask everything in one message, numbered, each with the answer you would
pick. Do not ask what you can read in the code. Wait for the answers.

Then write the spec with the `om-spec-writing` skill. Its repo overlay (`.ai/skills/om-spec-writing/SKILL.md`)
adds this repository's sections. Put every item of the checklist into the spec as a task or an acceptance check.
The file is `.ai/specs/{YYYY-MM-DD}-{kebab-case-title}.md`, with the line `Status: draft` right under the title.
Something only the user can do later (for example a recording of AIR with Junie) becomes the spec's first task.

## 4. Audit, at most three times

```bash
scripts/feature audit <spec> --writer <your model id>
```

Give your own model id (for example `claude-opus-5-5` or `gpt-6.1-sol`). If you are not sure of the id, give
your family instead: `claude`, `gpt`, `gemini` or `grok`; do not ask the user for it. The script picks a reviewer
from another model family (`.ai/review-matrix`). Its last output line is `VERDICT: APPROVED` or `VERDICT: CHANGES`,
and it prints the path of the audit. Read the whole audit.

- **APPROVED:** go to step 5.
- **CHANGES:**
  1. Findings marked `NEEDS USER:`, and any other finding that changes scope or behaviour: ask the user, all in
     one message, numbered, each with the answer you would pick. Wait for the answers.
  2. Revise the spec. Fix what the audit is right about; where it is wrong, keep the spec and note why.
  3. Write your reply to `.ai/runs/<spec name>/reply.<n>.md` (the script prints the path): one line per finding,
     what you changed or why you did not. The reviewer reads it in the next audit.
  4. Run the audit again.

After the third audit, stop auditing whatever its verdict. If it still says CHANGES, revise once more and tell
the user plainly which findings are open and that the last revision was not audited.

## 5. The user approves

Show the user: the spec's path and type, a summary in a few lines, the verdict of the last audit with its path,
and the open questions that remain. Ask one question: start the task, change something, or stop here.

- **Change something:** revise; if the change is more than wording, audit again if an audit is left.
- **Stop here:** leave the spec as a draft, or run `scripts/feature reject <spec>` if they reject it. Done.

## 6. Start the task

Only after the user said to start:

```bash
scripts/feature queue <spec>
```

This sets `Status: approved`, commits that one file on `main` and creates a Cezar task with the workflow
`feature-from-spec`. Cezar then makes the worktree, implements, runs the checks, reviews, has Opus and Sol review
through Pi, and stops at its review gate.

- If the script says Cezar is not running, pass on the two commands it prints and stop; do not start Cezar.
- Tell the user the task id and where to watch it, and what comes after the review gate: the `air-test-handoff`
  skill, then their "merge".

## Rules

- You edit only the spec and your reply files. No implementation and no branch in this skill; the only commit is
  the one `scripts/feature queue` makes after the user's approval.
- The reviewer reports and changes nothing; you do not edit its audits.
- Never copy keys, tokens, headers or home paths out of `acp-examples/` into a spec.
- If the request is a bug rather than a feature, say so and use `om-troubleshooter` instead.
