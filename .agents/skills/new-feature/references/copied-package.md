# Checklist: change to a copied package

`packages/junie-cost` and `packages/jetbrains-ai` are copies taken from the junie-pi repository. Each README starts
with a note saying when it was copied and what differs.

1. **Upstream first.** Does the change belong in junie-pi? If yes, the spec says so and the user decides whether
   to change it there and re-copy, or to diverge here.
2. **Keep the difference small and listed.** Every divergence is added to the "Changes in this copy" note at the
   top of the package's README, in one line.
3. **Do not copy what needs secrets.** Live tests that need a key or model quota stay out of the copy.
4. **Both uses still work.** The package is loaded by the bridge and can be loaded in plain Pi
   (`pi -e ./packages/<name>`). A change must not break either.
5. **Tests and checks.** The package's own `check`, its tests if it has any, and the bridge tests that cover it
   (`junie-cost.test.ts`, `junie-keys.test.ts`, `eco.test.ts`).
