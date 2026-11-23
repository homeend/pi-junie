---
name: air-test-handoff
description: Use when a pi-junie branch has passed its checks and reviews and the user has to try it by hand in JetBrains AIR, e.g. "hand over for testing", "ready to test in AIR". Points the pi-junie-dev agent entry at the branch's worktree and gives the user the exact steps to check.
---

# Hand over a branch for testing in AIR

Tests and reviews cannot see what AIR shows. A person tries each feature in AIR before it is merged. Only one
build is under test at a time.

## Steps

1. **Preconditions.** In the branch's worktree: `npm run check` and `npm test` pass, and the second review has no
   open blocker. If not, say so and stop.
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
5. **Wait for the result.** Do not merge and do not ask to merge before the user reports that it works. If it
   fails, read the log with the user's description and go back to the implementation.

## Rules

- Do not edit `~/.jetbrains/acp.json`. If the `pi-junie-dev` entry is missing, show the user the snippet printed
  by `scripts/dev.sh air-test` and let them add it.
- Never paste the wire log into a file that is tracked; it can contain project content.
