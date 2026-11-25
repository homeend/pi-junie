# Checklist: change to a copied package

`packages/junie-cost` and `packages/jetbrains-ai` are copies taken from the junie-pi repository. Each README starts
with a note saying when it was copied and what differs. For a new copy of a third-party plugin, read
"A new copy" below first.

1. **Upstream first.** Does the change belong in junie-pi? If yes, the spec says so and the user decides whether
   to change it there and re-copy, or to diverge here.
2. **Keep the difference small and listed.** Every divergence is added to the "Changes in this copy" note at the
   top of the package's README, in one line.
3. **Do not copy what needs secrets.** Live tests that need a key or model quota stay out of the copy.
4. **Both uses still work.** The package is loaded by the bridge and can be loaded in plain Pi
   (`pi -e ./packages/<name>`). A change must not break either.
5. **Tests and checks.** The package's own `check`, its tests if it has any, and the bridge tests that cover it
   (`junie-cost.test.ts`, `junie-keys.test.ts`, `eco.test.ts`).

## A new copy

When the reuse decision (`reuse-decision.md`, option 5) is a local copy of a third-party plugin that we alter.
The points above apply from then on; these come first.

1. **Why a copy.** The spec lists the smaller options and the evidence each was rejected with: the plugin's
   settings, a conversion in the bridge, an add-on package, an upstream change.
2. **Licence.** It must allow copying and changing. Its text and the copyright notice stay in the package.
3. **Take the source without running it.** `npm pack <name>@<exact version>` in an empty temporary directory and
   unpack; no `npm install`, no scripts. Record the tarball's checksum (`npm view <name>@<version> dist.integrity`).
4. **Two commits.** First the unchanged source as `packages/<name>` with the README note; then our changes. The
   first commit is what a later upstream version is compared with.
5. **README note**, at the top: the original's name, exact version, checksum, licence and date of the copy, then
   "Changes in this copy" with one line per change.
6. **Name and collisions.** Our package gets its own name. Say what happens when the user also has the original
   installed: tool and command names, saved entries, settings. The bridge loads ours and skips the original, or
   the spec says why both can run.
7. **Saved state.** Whether sessions written by the original can be read by the copy, and the other way round.
8. **Updates.** Who looks at new upstream versions and when, and how a change there reaches the copy (compare
   with the first commit, apply by hand). A new upstream version that covers our change ends the copy.
9. **Package shape and loading** as for our own packages (`own-plugin.md`, points 3 to 7).
