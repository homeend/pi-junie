/**
 * Eco virtual models (COST-06): `jetbrains-ai/<id>-eco` stays the session model, and each request goes to a physical
 * model of the pair. The primary model works on a task until the planner accepts a plan; then the cheap
 * implementation model takes the rest of the task over. The router stores no state: the planner tracks the task's
 * phase and the implementation model's failed turns, and tells the router where the next request goes.
 *
 * Junie sources cite `path:line` in Junie origin/main de451b0f75 (2026-11-21), with `llm/` for
 * `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm`.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionContext, ExtensionVirtualModel, ModelRoute, ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { firstAvailable } from "../utils.ts";

const PROVIDER = "jetbrains-ai";
const ECO_SUFFIX = "-eco";

// Junie's picker offers Eco for the models that are not deprecated and have ecoModeEfforts
// (llm/ModelParameters.kt:893–1018). It leaves out Low for Opus 5.5 and starts GPT-6.1 Terra at Medium, so their
// pairs omit `low`; GPT-6.2 Astra and GPT-6.2 Sol, offered from Medium, have no pairs here. `contextWindow` is the
// primary model's, which Pi shows until the first response.
const ECO_MODELS: { id: string; contextWindow: number; thinkingLevels: ModelThinkingLevel[] }[] = [
	{ id: "claude-fable-5-1", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "claude-fable-5-2", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "claude-opus-5", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "claude-opus-5-5", contextWindow: 1_000_000, thinkingLevels: ["medium", "high"] },
	{ id: "gpt-5.6-sol", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "gpt-5.6-terra", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "gpt-6-sol", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "gpt-6-astra", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "gpt-6.1-sol", contextWindow: 1_000_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "gpt-6.1-terra", contextWindow: 1_050_000, thinkingLevels: ["medium", "high"] },
	{ id: "grok-4.6", contextWindow: 500_000, thinkingLevels: ["low", "medium", "high"] },
	{ id: "grok-4.7", contextWindow: 500_000, thinkingLevels: ["low", "medium", "high"] },
];

// Junie's implementation models in order of preference, at high effort (llm/DefaultModelRequirements.kt:256–266).
export const IMPLEMENTATION_MODEL_IDS = ["gpt-6-luna", "claude-haiku-5-5"];

/** Id of the primary model of an Eco pair, or undefined for any other model. */
export function ecoPrimaryId(model: Model<Api> | undefined): string | undefined {
	if (model?.provider !== PROVIDER) return undefined;
	return ECO_MODELS.find((eco) => `${eco.id}${ECO_SUFFIX}` === model.id)?.id;
}

export function isEcoModel(model: Model<Api> | undefined): boolean {
	return ecoPrimaryId(model) !== undefined;
}

/**
 * The physical model and thinking level of one request on the pair with `primaryId`. The implementation model gets
 * the requests the planner gives it (R11, R14) and the requests outside the agent loop (R17); the primary model gets
 * the rest (R3, R15).
 */
function route(
	primaryId: string, useImplementationModel: boolean, request: ModelRouteRequest, ctx: ExtensionContext,
): ModelRoute {
	const primary = firstAvailable(ctx, PROVIDER, [primaryId]);
	if (!primary) throw new Error(`Eco mode requires ${PROVIDER}/${primaryId} with valid credentials`);
	const { failed, previous } = request;
	// A retry goes to the model and thinking level that failed (R13).
	if (failed) return { model: failed.model, thinkingLevel: failed.thinkingLevel ?? request.thinkingLevel };
	const implementation = firstAvailable(ctx, PROVIDER, IMPLEMENTATION_MODEL_IDS) ?? primary;
	const model = request.reason === "direct" || useImplementationModel ? implementation : primary;
	// As in Junie, the implementation model works at high effort; the primary model keeps the selected level.
	const thinkingLevel = model === primary ? request.thinkingLevel : "high";
	// A continuation on the model of the previous response keeps that response's thinking level (R13).
	if (request.reason === "continuation" && previous
		&& previous.model.provider === model.provider && previous.model.id === model.id) {
		return { model, thinkingLevel: previous.thinkingLevel ?? thinkingLevel };
	}
	return { model, thinkingLevel };
}

/**
 * The Eco virtual models (R1). `useImplementationModel` tells whether the next request of the current task goes to
 * the implementation model; the planner tracks it.
 */
export function ecoModels(useImplementationModel: () => boolean): ExtensionVirtualModel[] {
	return ECO_MODELS.map(({ id, contextWindow, thinkingLevels }) => ({
		provider: PROVIDER,
		id: `${id}${ECO_SUFFIX}`,
		name: `${id} (Eco)`,
		thinkingLevels,
		contextWindow,
		route: (request, ctx) => route(id, useImplementationModel(), request, ctx),
	}));
}
