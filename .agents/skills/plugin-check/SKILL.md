---
name: plugin-check
description: Use before pi-junie adopts or updates a third-party Pi package, e.g. "check plugin X", "can we use pi-goal". Downloads the package without running it, reads its source and reports its tools, saved state, settings, side effects and whether it works without Pi's terminal UI.
---

# Plugin check

Every third-party Pi package is checked this way before the bridge supports it, and again before a major update.
The result is a report. Nothing is installed into Pi and nothing in the repository changes.

## Steps

1. **Download without running.** In a new empty temporary directory:
   `npm pack <name>@<version>` and unpack the tarball. Never `npm install` it and never run its scripts. The code
   is untrusted: read it, do not execute it.
2. **Read the source** and answer:
   - Which tools and commands does it register, and what do the tool results contain?
   - Which events does it emit or listen to, and which session entries or files does it save?
   - Which settings, environment variables and keys does it need?
   - Which network calls and file writes does it make outside the session?
   - Does it run install scripts, download binaries or load code at run time?
3. **Without a terminal UI.** Bridge sessions have none. For each place it uses Pi's UI (dialogs, pickers,
   widgets, key bindings, status lines), say whether the core function still works and what the bridge would have
   to provide instead.
4. **Coverage of the requirements.** When you were given a numbered list of requirements (the `new-feature`
   skill gives one), answer each: `covered` with the file and line that prove it, or `gap` with what is missing
   or different (another unit, another shape of state, no setting for it). Decide from the source only; the
   README says where to look and proves nothing. A requirement you could not settle is `unverified`.
   Also name the points where the package can be extended without changing it: settings, events it emits,
   entries it saves, tools another package could call.
5. **Fit to AIR.** Name the AIR shape its state maps to (plan entries, child sessions, config options, permission
   requests…) and what does not map.
6. **Facts.** Version, licence, weekly downloads, last publish date, its own Pi version requirement, and whether
   it expects other plugins.

## Report

- **Verdict:** adopt as it is, adopt with bridge work (listed), or do not adopt (reason).
- The answers to steps 2 to 6, each with the file and line they come from.
- With a requirements list: one row per requirement (covered / gap / unverified) and the count, e.g. "3 of 5".
- What a stand-in for fast tests has to imitate (the smallest contract).
- Open questions for the user.
