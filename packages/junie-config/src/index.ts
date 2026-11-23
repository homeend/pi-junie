/**
 * Junie Config: runs Pi with Junie's configuration (docs/eval-parity-plan.md).
 * - Records Junie's settings from the environment in the session, as Junie records `agent_configuration`.
 * - Applies Junie's behavior settings: step limit, project structure, tool switches, request options (behavior.ts).
 * - Shapes requests to Junie's custom model profiles (`extraBody`, `temperature`).
 * Credentials, model choice and the profiles' providers are applied by whoever runs Pi (pi-junie's bridge), from
 * `credentials.ts`, `profiles.ts` and `profile-provider.ts`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { junieBehavior, projectStructure } from "./behavior.ts";
import { PROFILE_PROVIDER_PREFIX } from "./profile-provider.ts";
import { loadJunieProfiles, profileDirectories } from "./profiles.ts";
import { withProfileOptions, withRequestSettings } from "./request-options.ts";
import { configurationRecord, resolveJunieSettings } from "./settings.ts";
import { promptUsageLogMessage, sessionUsage } from "./usage.ts";

/** Custom entry type of the configuration record. */
export const JUNIE_CONFIG_ENTRY = "junie-config";
/** Custom entry type of a run Junie's step limit ended (Junie's exit status `ExitMaxIter`). */
export const JUNIE_EXIT_ENTRY = "junie-exit";

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

	// Prompt usage log (JUNIE_LOG_PROMPT_USAGE / Junie's --log-prompt-usage): when a run settles, one line per new
	// prompt with its tokens and cost, in `<JUNIE_HOME>/logs/log-prompt-<date>-pid-<pid>.log` as Junie writes it.
	if (process.env.JUNIE_LOG_PROMPT_USAGE?.trim().toLowerCase() === "true") {
		let logged = 0;
		pi.on("agent_settled", (_event, ctx) => {
			const prompts = sessionUsage(ctx.sessionManager.getEntries()).prompts.filter((p) => p.index > logged);
			if (!prompts.length) return;
			logged = prompts.at(-1)!.index;
			try {
				const dir = join(process.env.JUNIE_HOME?.trim() || join(homedir(), ".junie"), "logs");
				mkdirSync(dir, { recursive: true });
				const now = new Date();
				const file = join(dir, `log-prompt-${now.toISOString().slice(0, 10)}-pid-${process.pid}.log`);
				appendFileSync(file, prompts.map((p) => `${now.toISOString()} INFO  JuniePromptUsage - ${promptUsageLogMessage(p)}\n`).join(""));
			} catch {
				// The log is a convenience: a failed write must not fail the run.
			}
		});
	}

	const behavior = junieBehavior();

	// Step limit (MAX_STEPS): count the run's completed turns and end the run at the limit, as Junie's agent loop stops
	// after maxSteps steps. The record says why the run ended.
	if (behavior.maxSteps) {
		const limit = behavior.maxSteps;
		let steps = 0;
		pi.on("agent_start", () => {
			steps = 0;
		});
		pi.on("turn_end", (_event, ctx) => {
			if (++steps < limit || ctx.signal?.aborted) return;
			pi.appendEntry(JUNIE_EXIT_ENTRY, { status: "ExitMaxIter", steps, maxSteps: limit });
			ctx.abort();
		});
	}

	// Project structure (ADD_PROJECT_STR=true): Junie's root listing as a system prompt section, stable within a
	// session so the prompt cache stays valid; tool switches: the turned-off tools stay inactive in every run.
	const structures = new Map<string, string | undefined>();
	if (behavior.addProjectStructure || behavior.disabledTools.length) {
		pi.on("before_agent_start", (event, ctx) => {
			if (behavior.addProjectStructure) {
				if (!structures.has(ctx.cwd)) structures.set(ctx.cwd, projectStructure(ctx.cwd));
				const text = structures.get(ctx.cwd);
				if (text) event.systemPromptOptions.sections.project_structure = text;
			}
			if (behavior.disabledTools.length) {
				const active = pi.getActiveTools();
				const kept = active.filter((t) => !behavior.disabledTools.includes(t));
				if (kept.length !== active.length) pi.setActiveTools(kept);
			}
		});
	}

	// Request options: Junie's PRIMARY_MODEL_* settings for every model, then a custom model profile's extraBody and
	// temperature for requests to that profile. The profiles are read from the same locations as the runner's (the
	// process's project and $JUNIE_HOME), matched by provider.
	const profiles = new Map(
		loadJunieProfiles(profileDirectories(process.cwd())).profiles.map((p) => [`${PROFILE_PROVIDER_PREFIX}${p.profileId}`, p.primary]),
	);
	const hasRequestSettings = Object.keys(behavior.request).length > 0;
	if (profiles.size || hasRequestSettings) {
		pi.on("before_provider_request", (event, ctx) => {
			if (!ctx.model) return undefined;
			const profile = profiles.get(ctx.model.provider);
			let payload = event.payload;
			if (hasRequestSettings) payload = withRequestSettings(payload, ctx.model.api, profile?.temperature !== undefined ? { ...behavior.request, temperature: undefined } : behavior.request);
			if (profile) payload = withProfileOptions(payload, profile);
			return payload === event.payload ? undefined : payload;
		});
	}
}
