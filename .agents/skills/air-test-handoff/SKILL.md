---
name: air-test-handoff
description: Use when a pi-junie branch has passed its checks and reviews and the user has to try it by hand, in JetBrains AIR or in plain Pi, e.g. "hand over for testing", "ready to test in AIR", "try it in the CLI". Covers AIR on the same machine, AIR on Windows with the repository in WSL, and plain Pi.
---

# Hand over a branch for testing by hand

Tests and reviews cannot see what AIR or Pi's terminal shows. A person tries each feature before it is merged, on
every surface its spec names: AIR ("Check in AIR") and plain Pi ("Check in plain Pi"). Only one build is under
test in AIR at a time.

Hand over only what the spec says can be tried. A spec with no "Check in AIR" section, or with the line "After
this spec: … nothing to try in AIR …", gets no AIR steps: tell the user in one line that this branch cannot be
seen in AIR yet and which spec brings it there. Never send the user to try a command, skill or tool you have not
found in the build they will run: in the log for AIR, in the worktree's files for plain Pi.

- **The user asks for a surface the spec leaves out** ("let me try it in AIR"): say that it cannot work there
  yet and why, in a few lines, and hand over the surfaces that can. Do not copy the build to AIR "to have a look".
- **The spec has no check sections at all** (surfaces and hand checks folded into a paragraph): go by what it
  says it supports, write the steps yourself, mark them as yours, and tell the user the spec lacks them.
- **How things are typed.** Plain Pi: a skill is `/skill:<name>`, a plugin command is `/<name>`. AIR: a skill is
  `$<name>` from the command list; a plugin command does not exist. A tool has no command anywhere: the user
  asks for it in words. Correct the user when they name a form that does not exist on that surface.

The AIR steps (2 to 5) apply only when the spec has a "Check in AIR" section.

## Steps

1. **Preconditions.** In the branch's worktree: `npm run check` and `npm test` pass, and the second review has no
   open blocker. Read the newest `second-review-opus-<n>.md` and `second-review-sol-<n>.md` in the task's
   artifacts (`.ai/cezar/artifacts/<task>/`): both must end in "approve", or the user accepted the branch at
   Cezar's "Reviews not clean" question. Show the user the "For the owner" items and `for-the-owner.md` before
   the hand test. If a precondition fails, say so and stop.
2. **Put the branch where AIR runs it.** Ask the user where their AIR runs if you do not know; do not guess from
   the files you can see.
   - AIR reads the same machine's `~/.jetbrains/acp.json` (Linux, macOS, or an IDE running inside WSL):
     `scripts/dev.sh air-test <worktree path>`. It moves one fixed link; AIR's `pi-junie-dev` agent entry runs
     whatever the link points at.
   - The repository is in WSL and AIR runs on Windows: `scripts/dev.sh win-test <worktree path>`. It copies the
     worktree's last commit to `%LOCALAPPDATA%\pi-junie-dev`, installs Windows modules and prints the agent entry
     for the Windows `acp.json`. Uncommitted changes are not copied; commit first. A WSL worktree cannot be run by
     Windows AIR directly, and copying `node_modules` from WSL does not work (Linux binaries and links).
   If the command reports that another build was under test, tell the user which one it replaced.
3. **Write the test steps** from the spec's "Check in AIR" section: what to click or type, in order, and what
   should appear. Add what must still work around the feature (a normal chat, a tool call with a permission
   prompt).
4. **Make AIR load the build, and prove it from the log before the user tests.** AIR keeps one bridge process
   per agent entry and reuses it for new chats, so after `win-test` (new files) the process has to be restarted:
   ask the user to restart the agent or the IDE. Do not stop it yourself. Then read the log
   (`<build folder>/.pi-dev/pi-air.log`, readable part: `grep -v ':wire ' …`) and check:
   - the last `starting pid=` line is later than the copy or the link change;
   - every plugin the spec needs has a `plugin <name> … built in` line;
   - after the user's first prompt: the session's `skills [...]` line holds each skill the steps use.
   A tool is offered only when the bridge switches it on (`references/own-plugin.md` of `new-feature`, item 6): a
   "built in" line does not prove the tool exists. If a check fails, fix that first; give no steps.
5. **Tell the user:**
   - start a **new** chat with the entry under test (`pi-junie-dev`);
   - the test steps, with the exact text to type. Skills are in AIR's command list as `$<name>`; a plugin's
     `/command` does not exist there;
   - where the log is.
6. **Plain Pi**, when the spec has a "Check in plain Pi" section: give the user the command
   `scripts/dev.sh cli-test <worktree path>` (add `-- -p "<prompt>"` for a headless check) and the steps from that
   section. It runs the worktree's Pi with all its packages and a Pi folder inside the worktree
   (`.pi-dev/cli-agent`); the user's `~/.pi/agent` is not touched. To start clean, delete that folder. Pi starts
   in the worktree, so the worktree's own skills (`.agents/skills`) are found. Without a "Check in plain Pi"
   section, see the rule above.
7. **Wait for the result.** Do not merge and do not ask to merge before the user reports that it works on each
   surface the spec has a check for. If it fails, read the log with the user's description (in plain Pi: the session file in
   `.pi-dev/cli-agent/sessions/`) and go back to the implementation.

## Rules

- Do not edit `acp.json` (WSL or Windows). If the `pi-junie-dev` entry is missing, show the user the snippet
  printed by `scripts/dev.sh air-test` or `win-test` and let them add it.
- Do not patch the copy under test to make a feature appear. What the branch lacks, the user must see as lacking.
- Do not copy a skill into the user's project or home folder without asking.
- Never paste the wire log into a file that is tracked; it can contain project content.
