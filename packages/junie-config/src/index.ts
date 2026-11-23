/**
 * Junie Config: runs Pi with Junie's configuration (docs/eval-parity-plan.md). This first part reads Junie's settings
 * from the environment and records them in the session, as Junie records `agent_configuration` for every run.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configurationRecord, resolveJunieSettings } from "./settings.ts";

/** Custom entry type of the configuration record. */
export const JUNIE_CONFIG_ENTRY = "junie-config";

export default function junieConfig(pi: ExtensionAPI): void {
	// Record the configuration once per session, when the environment sets any Junie setting: an eval or headless run
	// carries its configuration in the session file. Without Junie settings (e.g. a chat in AIR) nothing is recorded.
	// A resumed session keeps the record it has; the record is a custom entry, so the model never sees it.
	pi.on("session_start", (_event, ctx) => {
		const resolved = resolveJunieSettings();
		if (!resolved.some((r) => r.source === "env")) return;
		if (ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === JUNIE_CONFIG_ENTRY)) return;
		pi.appendEntry(JUNIE_CONFIG_ENTRY, configurationRecord(resolved));
	});
}
