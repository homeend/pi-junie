> **Repo-local override.** Extends the installed `om-pre-implement-spec` with what a pi-junie spec must contain.

## Context to read (add)

- `AGENTS.md`: its rules, and in its Task Router every row the spec touches; read the files those rows name.
- The checklist of the spec's type in `.agents/skills/new-feature/references/`, and the repo's spec sections in
  `.ai/skills/om-spec-writing/SKILL.md`. A missing section or checklist item is a finding.

## Checks (add)

Work out from the spec's requirements, not from its own labels, where the feature has to run and what it handles.
Then check:

- **Surfaces.** Does the feature run in plain Pi, in AIR, or both? The spec has the surface table of
  `references/surfaces.md` (or the line "Surfaces: AIR only") and it matches what the requirements need. Each
  surface in it has its UI, where its state is saved, a test and a hand check ("Check in AIR", "Check in plain
  Pi"). A surface the requirements need but the table lacks is a finding that blocks.
- **More than one type.** A spec whose work needs two types (for example a plugin package and a bridge change)
  has to be split: plugin first, one shared requirements list, `Depends on:` in the second. An unsplit one blocks.
  A spec with `Depends on:` names an existing spec and uses its R-numbers.
- **What the user has after this spec.** When a surface waits for a dependent spec, the first spec says so in one
  line of its own ("After this spec: works in …; nothing to try in … until …") and has no hand check for that
  surface. Missing, or buried in a paragraph, blocks. A plugin-only spec that claims AIR must show the bridge
  part: the plugin in the bridge's plugin list and its tools in the bridge's switched-on tools
  (`references/own-plugin.md`, item 6); otherwise AIR is not one of its surfaces.
- **Readable shape.** The surface table, the hand checks and the test plan are sections with their own headings,
  not one paragraph. A spec whose sections are folded into running text blocks: nobody can test from it.
- **State that crosses.** Anything plain Pi saves that the bridge would read (or the reverse) is named as a
  decision with its reason; the bridge's Pi folder is separate on purpose. Silent sharing is a finding.
- **Keys.** If any requirement takes, saves or sends a key, password or token: the spec says where it lives per
  surface and contains the checks of `references/credentials.md`. Start the finding with NEEDS USER: when the spec
  wants a file of ours for keys.
- **Across the boundary.** A feature in both a plugin package and the bridge has one test that runs through the
  bridge with the package loaded, and the package does not import `packages/bridge`.
- **AIR's own dialogs.** Where the spec relies on AIR calling a method, it says whether that is proven for
  pi-junie (a recording) or unverified with the recording as its first task.
