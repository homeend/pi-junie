# Checklist: bridge change

Work in `packages/bridge`. The spec must cover each point.

1. **How Junie does it.** Find the ACP messages in a recording (`acp-examples/<session>/derived/acp-messages.jsonl`,
   git-ignored) or in `junie-agent/docs/acp-air-communication.md`. No recording of this feature: the first task is
   for the user to record one in AIR with Junie.
2. **Fixture.** Turn the recording into a fixture; the script redacts headers, tokens and home paths:
   `node packages/bridge/scripts/extract-fixture.ts acp-examples/<session>/derived/acp-messages.jsonl <name> [--max-prompts N]`
3. **Test first.** A replay test in `packages/bridge/test/replay.test.ts`, or a focused test file next to the
   others, that fails before the implementation. Bridge behaviour against Pi uses the fake proxy
   (`test/fake-proxy.ts`), never a live model.
4. **Layers.** Say which of these change, and keep the boundaries (`test/architecture.test.ts`):
   - `src/core`: neutral types and ports; imports nothing but itself.
   - `src/acp`: ACP driver; never imports Pi.
   - `src/pi`: Pi bridge; never imports ACP.
   - `src/compat`: feature registry; standalone.
   A new kind of event crosses the layers as a neutral type in `core`.
5. **Capability.** If AIR must be told about the feature, add or update its entry in `src/compat/features.ts` and
   advertise it only when it really works.
6. **Docs in the same change.** The feature's row in `docs/air-pi-feature-map.md`, the behaviour in
   `packages/bridge/docs/spec.md`, and the README for a new switch, command or environment variable.
7. **Check in AIR.** The steps a person does in AIR, and what they should see.
