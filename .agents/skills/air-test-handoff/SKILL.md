---
name: air-test-handoff
description: Use when a pi-junie branch has passed its checks and reviews and the user has to try it by hand, in JetBrains AIR or in plain Pi, e.g. "hand over for testing", "ready to test in AIR", "try it in the CLI". Points the pi-junie-dev agent entry at the branch's worktree, gives the plain-Pi command, and gives the user the exact steps to check.
---

# Hand over a branch for testing by hand

Tests and reviews cannot see what AIR or Pi's terminal shows. A person tries each feature before it is merged, on
every surface its spec names: AIR ("Check in AIR") and plain Pi ("Check in plain Pi"). Only one build is under
test in AIR at a time.

## Steps

1. **Preconditions.** In the branch's worktree: `npm run check` and `npm test` pass, and the second review has no
   open blocker. Read the newest `second-review-opus-<n>.md` and `second-review-sol-<n>.md` in the task's
   artifacts (`.ai/cezar/artifacts/<task>/`): both must end in "approve", or the user accepted the branch at
   Cezar's "Reviews not clean" question. Show the user the "For the owner" items and `for-the-owner.md` before
   the hand test. If a precondition fails, say so and stop.
Steps 2 to 4 apply when the spec has a "Check in AIR" section.

2. **Point the test entry at this worktree:** `scripts/dev.sh air-test <worktree path>`. It moves one fixed link;
   AIR's `pi-junie-dev` agent entry runs whatever the link points at. If the command reports that another worktree
   was under test, tell the user which one it replaced.
3. **Write the test steps** from the spec's "Check in AIR" section: what to click or type, in order, and what
   should appear. Add what must still work around the feature (a normal chat, a tool call with a permission
   prompt).
4. **Tell the user:**
   - start a **new** chat with **pi-junie-dev** (a running chat keeps the old build);
   - the test steps;
   - where the log is: `<worktree>/.pi-dev/pi-air.log` (readable part: `grep -v ':wire ' …`).
5. **Plain Pi**, when the spec has a "Check in plain Pi" section: give the user the command
   `scripts/dev.sh cli-test <worktree path>` (add `-- -p "<prompt>"` for a headless check) and the steps from that
   section. It runs the worktree's Pi with all its packages and a Pi folder inside the worktree
   (`.pi-dev/cli-agent`); the user's `~/.pi/agent` is not touched. To start clean, delete that folder.
6. **Wait for the result.** Do not merge and do not ask to merge before the user reports that it works on each
   surface. If it fails, read the log with the user's description (in plain Pi: the session file in
   `.pi-dev/cli-agent/sessions/`) and go back to the implementation.

## Rules

- Do not edit `~/.jetbrains/acp.json`. If the `pi-junie-dev` entry is missing, show the user the snippet printed
  by `scripts/dev.sh air-test` and let them add it.
- Never paste the wire log into a file that is tracked; it can contain project content.
