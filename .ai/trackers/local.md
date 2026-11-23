# Tracker provider: local

This repository runs its agent process locally. There is no issue tracker and there are no pull requests in the
process. Work items are spec files in `.ai/specs/`, review is a report, and merging is done by hand by the owner.

## Prerequisites

`git`. Nothing else: no CLI login, no token, no network.

## Conventions

- A work item is a spec file: `.ai/specs/{YYYY-MM-DD}-{kebab-case-title}.md`. Refer to it by its path.
- A change is a local branch in its own git worktree. Refer to it by its branch name.
- There are no drafts, labels, assignees or claim comments.

## Label guards

`labels.enabled` is `false`. Skip every label operation without reporting it as a failure.

## Operations

### Identity and repository

- **auth-check**: `git rev-parse --is-inside-work-tree`. Nothing to authenticate.
- **current-user**: `git config user.name`.
- **repo-info**: `basename "$(git rev-parse --show-toplevel)"`.
- **default-branch**: `main`.

### Issues, pull requests, CI runs, labels

Not available here. A skill that needs any of these operations must stop and say which operation it needed. Do not
replace them with `gh`, a web request, `git push` or a commit to `main`.

What to do instead:

| The skill wants to | Do this |
| --- | --- |
| read the diff of a PR | `git diff "$(git merge-base main HEAD)"` in the branch's worktree (includes uncommitted work) |
| post a review or a comment | write the report in the reply; when asked to keep it, save it under `.ai/reviews/` |
| open, update or merge a PR | stop: the owner merges by hand after their explicit OK |
| read CI results | run the commands in `validation.commands` of `.ai/agentic.config.json` |
