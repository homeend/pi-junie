# What already exists: reuse, alter or build

Read in step 2 of the `new-feature` skill, before the change gets its type. The aim: know what an existing Pi
plugin already covers of this feature, and choose with the user between using it, altering it and building our
own. The result is the spec's "Reuse decision" section.

The method follows Open Mercato's `om-gap-analysis` (coverage per requirement, proven in code),
`om-eject-and-customize` (smallest option first, measure what a copy costs) and `om-brainstorm` (a challenger,
and "build nothing" always on the table).

## 1. Requirements

Write the feature as a numbered list of requirements, R1, R2, …: each one thing that can be checked. Include the
details that differ between implementations: units (tokens, credits, money), settings, saved state, what AIR must
show, what must work in a headless run. Requirements you are unsure of go to the user in step 3 of the skill.

## 2. Candidates

- The feature's row and notes in `docs/air-pi-feature-map.md`.
- The packages in `packages/` and the plugins the bridge already supports (`packages/bridge/src/pi/`).
- npm: `npm search --json "keywords:pi-package <words>"` with two or three wordings of the feature.

List each candidate with version, licence, weekly downloads and last publish date. No candidate: write
"No existing plugin found" with the searches you ran, and skip to section 4 with only options 6 and 7 open.

## 3. Coverage, from the source

For each serious candidate (at most three) run the `plugin-check` skill with the requirements list. Its report
gives one row per requirement:

| Requirement | Candidate A `name@version` | Candidate B |
| --- | --- | --- |
| R1 … | covered: `src/file.ts:120` | gap: counts tokens, has no credit unit |

- **Only the package's source at that exact version is evidence.** A README, the feature map and your memory say
  where to look; they never prove a row. A row without a file and line is `unverified`, not `covered`.
- The verdict per candidate follows from the rows: all covered, partly (n of m), or none.

## 4. Options, smallest first

For the gaps, walk the options in this order. Reject an option with evidence (a file and line, a documented
limit) or recommend it. Give every option that is not rejected its pros, its cons and what we take on.

1. **The plugin's own settings.** A setting, environment variable or documented hook already does it.
2. **Adopt as it is; the bridge converts.** The plugin runs unchanged and the bridge translates between it and
   AIR. Only when the conversion is honest: a unit the plugin does not know cannot be converted into one it does
   if the rate changes per model or per task.
3. **An add-on package beside the plugin.** A small package of ours in `packages/` that uses the plugin's tools,
   events or saved entries and adds the missing part. The plugin stays unchanged and updatable.
4. **A change in the plugin itself, upstream.** The need applies to every user of the plugin: an issue or a pull
   request to its author. Say what we do until it lands. A defect in the plugin is always this option.
5. **A local copy that we alter.** The plugin's source becomes a package in `packages/` and we change it. Needs a
   licence that allows it. We own every later update. Checklist: `copied-package.md`.
6. **Our own plugin, modelled on the existing one.** New code in `packages/`; the existing plugin is the reference
   for architecture and names, nothing is copied. Checklist: `own-plugin.md`.
7. **Build nothing.** Leave the feature, or this part of it, out. Say honestly what the user loses.

What we take on, for options 3, 5 and 6: the number of files and lines we own, the saved state and names that
must stay compatible (session entries, tool names, settings), what happens when the user also has the original
plugin installed, and the work each time the original publishes a new version.

## 5. Challenger

Before showing the recommendation, start one fresh sub-agent with only the requirements, the coverage table and
the options with your recommendation, and this instruction:

> You review a reuse decision for pi-junie. Attack it. Is a smaller option rejected without evidence? Is a
> "covered" row not proven by a file and line? Is a requirement missing or invented? Would the recommended option
> cost more in updates than a larger one? Is "build nothing" priced honestly? Answer with CRITICAL (the decision
> is wrong or unproven), WARNING and OK lines. No praise.

CRITICAL findings go to the user as questions; do not answer them yourself. Without a sub-agent tool, make the
same pass yourself as a separate step and write "Challenger: same session" in the spec.

## 6. The user decides

In the message of the skill's step 3, together with the other questions: the coverage table, the options with
pros, cons and what we take on, your recommendation, and the challenger's findings. The choice is the user's.

The choice gives the type of change:

| Chosen option | Type | Checklist |
| --- | --- | --- |
| 1 or 2 | Adopted Pi plugin | `adopt-plugin.md` |
| 3 | Own plugin package, plus the adopted plugin | `own-plugin.md` after `adopt-plugin.md`; two specs, plugin first |
| 4 | Adopted Pi plugin, with the upstream request as its first task | `adopt-plugin.md` |
| 5 | Copied package (a new copy) | `copied-package.md` |
| 6 | Own plugin package | `own-plugin.md` |
| 7 | none; the skill ends, or the spec covers the rest without this part | |

## 7. In the spec

The "Reuse decision" section holds: the requirements, the candidates, the coverage table, each option with the
reason it was rejected or chosen, what we take on, the challenger's findings and the user's decision. A later
reader must be able to see why the smaller options lost.
