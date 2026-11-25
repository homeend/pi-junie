# Brief for a sub-agent: draft one spec

You were started by the `new-feature` skill to draft the spec for ONE feature out of a larger document. Nobody can
answer questions during this run. Your whole result is one new file under `.ai/specs/`.

You were given: the feature's name, the source file, and the section (heading and line range) that describes it.

1. Read `AGENTS.md`. Read only your section of the source file, not the whole file.
2. Find the feature in `docs/air-pi-feature-map.md` and in the code. Check what pi-junie already does for it.
3. Classify the change and read its checklist, as in step 2 of `.agents/skills/new-feature/SKILL.md`.
   For the reuse decision (`reuse-decision.md`) do sections 1 and 2 only: the numbered requirements and the
   candidate plugins. Do not run `plugin-check`, start no sub-agent and choose no option. Classify by what the
   feature map says and write the choice of option as the first open question.
4. Write the spec with the `om-spec-writing` skill and its repo overlay (`.ai/skills/om-spec-writing/SKILL.md`):
   - file `.ai/specs/{today}-{kebab-case-title}.md`, with `Status: draft` right under the title;
   - a "Source" section: the source file's repository path, the section heading, and a short quote of the lines
     the spec rests on, so the spec can be read without the source;
   - every item of the checklist as a task or an acceptance check;
   - a "Reuse decision" section with the requirements, the candidates and the line "Coverage not checked yet";
   - cover only what pi-junie does not do yet; say in one line what already exists;
   - an "Open questions" section with everything you would have asked the user, numbered, each with the answer you
     would pick. Something only the user can do (for example a recording of AIR with Junie) is the first task.
5. Change no other file, write no code, commit nothing, run no audit.

If the feature turns out to be fully done already, write no spec and say so.

Answer with exactly these lines:

```
SPEC: <path, or "none">
TYPE: <bridge change | adopted Pi plugin | own plugin package | copied package>
SUMMARY: <one sentence>
OPEN QUESTIONS: <number>
```
