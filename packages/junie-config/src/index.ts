/**
 * Junie Config: runs Pi with Junie's configuration (docs/eval-parity-plan.md).
 * - Records Junie's settings from the environment in the session, as Junie records `agent_configuration`.
 * - Shapes requests to Junie's custom model profiles (`extraBody`, `temperature`).
 * Credentials, model choice and the profiles' providers are applied by whoever runs Pi (pi-junie's bridge), from
 * `credentials.ts`, `profiles.ts` and `profile-provider.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROFILE_PROVIDER_PREFIX } from "./profile-provider.ts";
import { loadJunieProfiles, profileDirectories } from "./profiles.ts";
import { withProfileOptions } from "./request-options.ts";
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

	// Requests to a custom model profile get the profile's extraBody and temperature, as Junie sends them. The profiles
	// are read from the same locations as the runner's (the process's project and $JUNIE_HOME), matched by provider.
	const profiles = new Map(
		loadJunieProfiles(profileDirectories(process.cwd())).profiles.map((p) => [`${PROFILE_PROVIDER_PREFIX}${p.profileId}`, p.primary]),
	);
	if (profiles.size) {
		pi.on("before_provider_request", (event, ctx) => {
			const model = ctx.model && profiles.get(ctx.model.provider);
			return model ? withProfileOptions(event.payload, model) : undefined;
		});
	}
}
