# Plugin manager

`/plugins` turns installed Pi packages on and off from inside Pi, without `pi config` or editing `settings.json`.

```
/plugins                  picker of the installed packages: pick one to switch it
/plugins off cost         switch a package off (its name, its source, or a unique part of either)
/plugins on jetbrains-ai  switch it on again
/plugins list             the packages and their state
```

A switch writes the package's entry in `settings.json` (user `~/.pi/agent`, or project `.pi`, wherever the package is
installed) the way `pi config` does: off is the filter `{"source": "...", "extensions": []}`, which loads none of the
package's extensions; on removes it again. Then Pi reloads, so the change applies to the running session at once and
stays for the next ones. The package stays installed either way.

pi-junie (the AIR bridge) honours the switch for the plugins it detects (subagents, todo list, plan mode, web
access) when its agent starts. Its built-in Junie Cost and Junie Config are controlled in AIR's `acp.json` instead.

The plugin manager lists itself but cannot switch itself off (that would remove `/plugins`); use `pi config` for it.

Install: `pi install <pi-junie>/packages/plugin-manager`. Tests: `npm test --workspace pi-junie-plugin-manager`.
