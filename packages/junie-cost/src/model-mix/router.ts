/**
 * Eco virtual models (COST-06): an Eco model stays the session model, and each request goes to a physical model of
 * its pair. The primary model works on a task until the planner accepts a plan; then the cheap implementation model
 * takes the rest of the task over.
 *
 * pi-junie changes (this copy):
 * - The route is decided from the request's own conversation (`implementationTurn`), not from the planner's state.
 *   Pi registers an extension's virtual model in the model runtime, which pi-junie shares between all its sessions;
 *   a router that read one planner's state routed every session by the session that registered it last.
 * - Pairs are provider-neutral (`ecoRoute`, `registerEcoTarget`): besides the `jetbrains-ai/<id>-eco` pairs registered
 *   here, a runner such as pi-junie registers Eco models of its own providers under `ECO_PROVIDER`, with a primary
 *   and an implementation model from any provider.
 *
 * Junie sources cite `path:line` in Junie origin/main de451b0f75 (2026-11-21), with `llm/` for
 * `core/src/main/kotlin/com/intellij/ml/llm/matterhorn/llm`.
 */
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionContext, ExtensionVirtualModel, ModelRoute, ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { firstAvailable } from "../utils.ts";
import { CREATE_PLAN, IMPLEMENT_FROM_PLAN, REPORT_PLAN } from "./prompts.ts";

const PROVIDER = "jetbrains-ai";
const ECO_SUFFIX = "-eco";
/** Provider of the Eco models a runner registers for its own providers (pi-junie). */
export const ECO_PROVIDER = "eco";

// Junie's picker offers Eco for the models that are not deprecated and have ecoModeEfforts
// (llm/ModelParameters.kt:893–1018). It leaves out Low for Opus 5.5 and starts GPT-6.1 Terra at Medium, so their
// pairs omit `low`; GPT-6.2 Astra and GPT-6.2 Sol, offered from Medium, have no pairs here. `contextWindow` is the
// primary model's, which Pi shows until the first response.
export const ECO_MODELS: { id: string; contextWindow: number; thinkingLevels: ModelThinkingLevel[] }[] = [
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

/** After this many failed implementation turns in a row, one request goes to the primary model (R14). */
const MAX_FAILED_TURNS = 3;

/** The physical models of an Eco model: resolved at each request, since availability changes with the providers. */
export interface EcoTarget {
	primary(): Model<Api> | undefined;
	implementation(): Model<Api> | undefined;
	/** Shown when the primary model is unavailable (R2). */
	primaryLabel: string;
}

// Eco models a runner registered under ECO_PROVIDER, by id.
const registered = new Map<string, EcoTarget>();

/** Make `ECO_PROVIDER/<id>` an Eco model of `target` (see isEcoModel, ecoTargetFor). */
export function registerEcoTarget(id: string, target: EcoTarget): void {
	registered.set(id, target);
}

/** Id of the primary model of a `jetbrains-ai` Eco pair, or undefined for any other model. */
function jetbrainsPrimaryId(model: Model<Api> | undefined): string | undefined {
	if (model?.provider !== PROVIDER) return undefined;
	return ECO_MODELS.find((eco) => `${eco.id}${ECO_SUFFIX}` === model.id)?.id;
}

export function isEcoModel(model: Model<Api> | undefined): boolean {
	if (!model) return false;
	return jetbrainsPrimaryId(model) !== undefined || (model.provider === ECO_PROVIDER && registered.has(model.id));
}

/** The physical models of an Eco model, or undefined for any other model. */
export function ecoTargetFor(model: Model<Api> | undefined, ctx: ExtensionContext): EcoTarget | undefined {
	if (model?.provider === ECO_PROVIDER) return registered.get(model.id);
	const primaryId = jetbrainsPrimaryId(model);
	return primaryId ? jetbrainsTarget(primaryId, ctx) : undefined;
}

function jetbrainsTarget(primaryId: string, ctx: ExtensionContext): EcoTarget {
	return {
		primary: () => firstAvailable(ctx, PROVIDER, [primaryId]),
		implementation: () => firstAvailable(ctx, PROVIDER, IMPLEMENTATION_MODEL_IDS),
		primaryLabel: `${PROVIDER}/${primaryId}`,
	};
}

function text(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Whether the next request of the conversation goes to the implementation model: the current task has an accepted
 * plan (a successful report_plan, or its folded form, the create_plan result with the implementation block; R11)
 * and no user message after it (R3), and the implementation model has not just failed MAX_FAILED_TURNS turns in a
 * row (R14: a turn fails when all its tool calls failed, or it has neither calls nor text; the turn after the
 * failures goes to the primary model, then the count starts over). Failed provider responses are not in the
 * conversation, so they are not counted (R13).
 */
export function implementationTurn(messages: readonly Message[]): boolean {
	const implementBlock = IMPLEMENT_FROM_PLAN.split("\n")[0];
	let planAt = -1;
	let userAt = -1;
	messages.forEach((m, i) => {
		if (m.role === "user") userAt = i;
		if (m.role === "toolResult" && !m.isError && (m.toolName === REPORT_PLAN || (m.toolName === CREATE_PLAN && text(m).includes(implementBlock)))) planAt = i;
	});
	if (planAt < 0 || userAt > planAt) return false;
	let failed = 0;
	for (let i = planAt + 1; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const results: Message[] = [];
		for (let j = i + 1; j < messages.length && messages[j].role === "toolResult"; j++) results.push(messages[j]);
		const turnFailed = results.length
			? results.every((r) => r.role === "toolResult" && r.isError)
			: !m.content.some((block) => block.type === "text" && block.text.trim() !== "");
		failed = failed < MAX_FAILED_TURNS && turnFailed ? failed + 1 : 0;
	}
	return failed < MAX_FAILED_TURNS;
}

/**
 * The physical model and thinking level of one request of an Eco model. The implementation model gets the task after
 * an accepted plan (R11, R14) and the requests outside the agent loop (R17); the primary model gets the rest (R3, R15).
 */
export function ecoRoute(target: EcoTarget, request: ModelRouteRequest): ModelRoute {
	const primary = target.primary();
	if (!primary) throw new Error(`Eco mode requires ${target.primaryLabel} with valid credentials`);
	const { failed, previous } = request;
	// A retry goes to the model and thinking level that failed (R13).
	if (failed) return { model: failed.model, thinkingLevel: failed.thinkingLevel ?? request.thinkingLevel };
	const implementation = target.implementation() ?? primary;
	const model = request.reason === "direct" || implementationTurn(request.messages) ? implementation : primary;
	// As in Junie, the implementation model works at high effort; the primary model keeps the selected level.
	const thinkingLevel = model === primary ? request.thinkingLevel : "high";
	// A continuation on the model of the previous response keeps that response's thinking level (R13).
	if (request.reason === "continuation" && previous
		&& previous.model.provider === model.provider && previous.model.id === model.id) {
		return { model, thinkingLevel: previous.thinkingLevel ?? thinkingLevel };
	}
	return { model, thinkingLevel };
}

/** The `jetbrains-ai/<id>-eco` virtual models (R1). */
export function ecoModels(): ExtensionVirtualModel[] {
	return ECO_MODELS.map(({ id, contextWindow, thinkingLevels }) => ({
		provider: PROVIDER,
		id: `${id}${ECO_SUFFIX}`,
		name: `${id} (Eco)`,
		thinkingLevels,
		contextWindow,
		route: (request, ctx) => ecoRoute(jetbrainsTarget(id, ctx), request),
	}));
}
