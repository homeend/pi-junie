/**
 * `/plugins`: turn installed Pi packages on and off from inside Pi, without `pi config` or editing settings.json.
 *
 * - `/plugins` opens a picker of the installed packages (user and project settings); picking one switches it.
 * - `/plugins off <name>`, `/plugins on <name>`, `/plugins list` do the same by name (a unique part is enough).
 *
 * A switch writes the package's filter in settings.json the way `pi config` does (packages.ts) and reloads Pi, so the
 * change applies to the running session at once and stays for the next ones. This package lists itself but cannot
 * switch itself off from here (that would remove the command); use `pi config` for that.
 */
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { findPackages, type InstalledPackage, isEnabled, packageName, type PackageEntry, type Scope, sourceOf, withEnabled } from "./packages.ts";

const SELF = "pi-junie-plugin-manager";

function installed(settings: SettingsManager, cwd: string): InstalledPackage[] {
	const read = (scope: Scope, entries: readonly PackageEntry[] | undefined, baseDir: string) =>
		(entries ?? []).map((e) => ({ scope, source: sourceOf(e), name: packageName(sourceOf(e), baseDir), enabled: isEnabled(e) }));
	return [
		...read("user", settings.getGlobalSettings().packages as PackageEntry[] | undefined, getAgentDir()),
		...read("project", settings.getProjectSettings().packages as PackageEntry[] | undefined, join(cwd, ".pi")),
	];
}

const label = (p: InstalledPackage) => `${p.enabled ? "✓ on " : "✗ off"}  ${p.name}${p.scope === "project" ? "  (project)" : ""}`;

/** Switches one package in its own scope's settings; false when nothing changed. */
async function setEnabled(settings: SettingsManager, pkg: InstalledPackage, enabled: boolean): Promise<boolean> {
	const entries = [...((pkg.scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [])] as PackageEntry[];
	const index = entries.findIndex((e) => sourceOf(e) === pkg.source);
	const next = index >= 0 ? withEnabled(entries[index], enabled) : undefined;
	if (next === undefined) return false;
	entries[index] = next;
	if (pkg.scope === "project") settings.setProjectPackages(entries as never);
	else settings.setPackages(entries as never);
	await settings.flush();
	return true;
}

async function switchPackage(ctx: ExtensionCommandContext, settings: SettingsManager, pkg: InstalledPackage, enabled: boolean): Promise<void> {
	if (pkg.name === SELF && !enabled) {
		ctx.ui.notify(`${SELF} provides /plugins and cannot switch itself off here; use \`pi config\`.`, "warning");
		return;
	}
	if (!(await setEnabled(settings, pkg, enabled))) {
		ctx.ui.notify(`${pkg.name} is already ${enabled ? "on" : "off"}.`, "info");
		return;
	}
	ctx.ui.notify(`${pkg.name} switched ${enabled ? "on" : "off"}; reloading.`, "info");
	await ctx.reload();
}

export default function pluginManager(pi: ExtensionAPI): void {
	pi.registerCommand("plugins", {
		description: "Turn installed Pi packages on or off: /plugins, /plugins off <name>, /plugins on <name>, /plugins list",
		handler: async (args, ctx) => {
			const settings = SettingsManager.create(ctx.cwd, getAgentDir());
			const packages = installed(settings, ctx.cwd);
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!packages.length) {
				ctx.ui.notify("No Pi packages are installed (pi install <source>).", "info");
				return;
			}
			if (verb === "on" || verb === "off") {
				const matches = findPackages(packages, rest.join(" "));
				if (matches.length !== 1) {
					ctx.ui.notify(matches.length ? `Several packages match: ${matches.map((m) => m.name).join(", ")}` : `No installed package matches "${rest.join(" ")}".`, "warning");
					return;
				}
				await switchPackage(ctx, settings, matches[0], verb === "on");
				return;
			}
			if (verb === "list" || !ctx.hasUI) {
				ctx.ui.notify(packages.map(label).join("\n"), "info");
				return;
			}
			if (verb) {
				ctx.ui.notify(`Unknown argument "${verb}". Use /plugins, /plugins on <name>, /plugins off <name> or /plugins list.`, "warning");
				return;
			}
			const options = packages.map(label);
			const picked = await ctx.ui.select("Switch a package on or off", options);
			const pkg = picked === undefined ? undefined : packages[options.indexOf(picked)];
			if (pkg) await switchPackage(ctx, settings, pkg, !pkg.enabled);
		},
	});
}
