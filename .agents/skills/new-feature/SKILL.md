---
name: new-feature
description: Use when the user wants to add or change a feature of pi-junie, e.g. "new feature", "add goal mode", "support plugin X", "change the bridge so that…". Classifies the change (bridge, adopted Pi plugin, own plugin package, copied package), loads that type's checklist and produces an approved spec before any code is written.
---

# New feature

The entry point of this repository's development process (`docs/development.md`). It ends with a spec file, not
with code. Do not edit anything outside `.ai/specs/` while this skill runs.

## Steps

1. **Understand the request.** Read `AGENTS.md`. Find the feature in `docs/air-pi-feature-map.md` (its row says
   whether Pi core, a Pi plugin or the bridge provides it) and in `docs/eval-parity-plan.md` if it concerns
   headless or eval runs. If the user gave no item, list the feature map's open rows and ask which one.

2. **Classify the change** into exactly one type and say which and why. A feature that needs two types is split
   into two specs, plugin first.

   | Type | It is this when | Checklist |
   | --- | --- | --- |
   | Bridge change | the work is in `packages/bridge` and no new plugin is involved | `references/bridge-change.md` |
   | Adopted Pi plugin | an existing npm Pi package provides the behaviour and the bridge maps it to AIR | `references/adopt-plugin.md` |
   | Own plugin package | new behaviour that should also work in plain Pi, as a package in `packages/` | `references/own-plugin.md` |
   | Copied package | a change inside `packages/junie-cost` or `packages/jetbrains-ai` | `references/copied-package.md` |

3. **Read that checklist** and collect what it asks for (recordings, fixtures, plugin source, upstream state)
   before asking the user anything.

4. **Write the spec** with the `om-spec-writing` skill. Its repo overlay (`.ai/skills/om-spec-writing/SKILL.md`)
   adds this repository's sections. Put every item of the checklist into the spec as a task or an acceptance
   check. The spec goes to `.ai/specs/{YYYY-MM-DD}-{kebab-case-title}.md`.

5. **Stop and hand over.** Tell the user:
   - the spec's path and its type;
   - the open questions, if any;
   - the next step: `scripts/feature review <spec>` has a model from another family audit the spec and lets it
     be revised; `scripts/feature queue <spec>` is their approval and sends it to Cezar. Implementation starts
     only after they approve the spec.

When `scripts/feature` runs this skill unattended, nobody can answer: follow the instructions in its prompt
(decide what the repository lets you decide, list the rest under "Open questions") instead of asking.

## Rules

- No implementation, no branch, no commit in this skill.
- Never copy keys, tokens, headers or home paths out of `acp-examples/` into a spec.
- If the request is a bug rather than a feature, say so and use `om-troubleshooter` instead.
