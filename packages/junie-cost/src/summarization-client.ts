import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelsApiStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { firstAvailable } from "./utils.ts";
import { ecoPrimaryId, IMPLEMENTATION_MODEL_IDS } from "./model-mix/router.ts";

export interface SummarizationOptions {
	/** Required deadline for the entire request, including authentication. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Output limit, defaulting to 1024 and capped by the model. */
	maxTokens?: number;
	/** Kind of the Pi `usage` entry that records the request's cost, e.g. `tool_output_summary`. */
	usageKind: string;
}

// Prefer modern budget models, then older IDs for providers with a limited catalog.
// This is an explicit preference order, not a price comparison or a cross-provider router.
const CHEAP_MODELS = {
	openai: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-nano"],
	anthropic: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
	google: [
		"gemini-3.5-flash-lite",
		"gemini-3.1-flash-lite",
		"gemini-3.1-flash-lite-preview",
		"gemini-2.5-flash-lite",
		"gemini-flash-lite-latest",
	],
} as const;

function modelFamily(model: Model<Api>) {
	// Gateway IDs may include a vendor prefix, e.g. anthropic/claude-sonnet-5-5.
	const id = model.id.split("/").at(-1)!;
	if (["openai", "openai-codex", "azure"].includes(model.provider) || id.startsWith("gpt-")) return "openai";
	if (model.provider === "anthropic" || id.startsWith("claude-")) return "anthropic";
	if (["google", "google-vertex"].includes(model.provider) || id.startsWith("gemini-")) return "google";
	return undefined;
}

/** Stay on the configured provider; use the primary model if no preferred model is available. */
export function selectSummarizationModel(ctx: ExtensionContext) {
	const selected = ctx.model;
	if (!selected) return undefined;
	// ModelRegistry.complete does not route virtual models, so an Eco pair maps to the model of its requests outside
	// the agent loop (COST-06.R17): the first available implementation model, or else the pair's primary model.
	const ecoPrimary = ecoPrimaryId(selected);
	const primary = ecoPrimary
		? firstAvailable(ctx, selected.provider, [...IMPLEMENTATION_MODEL_IDS, ecoPrimary])
		: selected;
	if (!primary) return undefined;
	const family = modelFamily(primary);
	if (!family) return primary;
	return firstAvailable(ctx, primary.provider, CHEAP_MODELS[family]) ?? primary;
}

function requestOptions(model: Model<Api>, options: SummarizationOptions, signal: AbortSignal): ModelsApiStreamOptions<Api> {
	// In Pi's capability map, null explicitly forbids a level; undefined uses the provider default mapping.
	const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const level = levels.find((candidate) => model.thinkingLevelMap?.[candidate] !== null);
	const base = {
		cacheRetention: "none" as const,
		temperature: 0,
		maxTokens: Math.min(options.maxTokens ?? 1024, model.maxTokens),
		maxRetries: 0,
		signal,
	};
	// Provider-specific options avoid implicit thinking-token budgets added by simple streaming helpers.
	// Pi's adapters omit sampling parameters on models that do not support them.
	switch (model.api) {
		case "openai-responses":
		case "openai-completions":
		case "openai-codex-responses":
		case "azure-openai-responses":
			// Without capability metadata, low is safer than minimal on OpenAI-compatible gateways.
			return { ...base, reasoningEffort: model.reasoning ? (model.thinkingLevelMap ? level : "low") : undefined };
		case "anthropic-messages":
			return { ...base, thinkingEnabled: false, effort: "low" };
		case "google-generative-ai":
		case "google-vertex":
			return {
				...base,
				thinking: model.reasoning && model.thinkingLevelMap && level
					? { enabled: true, level: level.toUpperCase() }
					: { enabled: false },
			};
		default:
			return { ...base, reasoning: model.reasoning ? level : undefined };
	}
}

/** Fail open: optimizations must not block or break the caller's normal behavior. */
async function withDeadline<T>(
	options: SummarizationOptions,
	operation: (signal: AbortSignal) => Promise<T | undefined>,
): Promise<T | undefined> {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.signal?.aborted) return undefined;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel = () => {};
	const cancelled = new Promise<undefined>((resolve) => {
		cancel = () => {
			controller.abort();
			resolve(undefined);
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		timer = setTimeout(cancel, options.timeoutMs);
	});
	try {
		// Abort alone cannot bound a provider that ignores the signal; race also bounds our wait.
		// Cancellation at the provider is best-effort and does not guarantee zero billing.
		return await Promise.race([operation(controller.signal), cancelled]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

/**
 * Records a response as Pi's own `usage` entry, as Pi does for cache warming, so that session stats, the cost
 * breakdown and both footers count it. `appendUsage` is missing from the extension's read-only session manager type,
 * so it is called only if present; any failure leaves the usage unrecorded. Details: COST-ADR-02.
 */
function recordUsage(ctx: ExtensionContext, kind: string, { provider, model, responseModel, usage }: AssistantMessage) {
	// A request aborted before the provider reported usage has nothing to record.
	if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return;
	try {
		const manager = ctx.sessionManager as Partial<Pick<SessionManager, "appendUsage">>;
		manager.appendUsage?.(kind, provider, responseModel ?? model, usage);
	} catch {
		// Accounting must not cost the caller its response; a late response may also outlive its session.
	}
}

/** Auxiliary calls never enter session history; undefined means the caller should keep its fallback. */
export function createSummarizationClient(ctx: ExtensionContext) {
	return {
		/** Return a fully completed response from the selected model, or undefined on failure, timeout, or cancellation. */
		complete: (context: Context, options: SummarizationOptions) =>
			withDeadline(options, async (signal) => {
				const model = selectSummarizationModel(ctx);
				if (!model || signal.aborted) return undefined;
				const result = await ctx.modelRegistry.complete(model, context, requestOptions(model, options, signal));
				// Every billed response is recorded, including rejected ones and those that arrive after the deadline.
				recordUsage(ctx, options.usageKind, result);
				// Partial, tool-calling, and failed responses must not replace the original data.
				return result.stopReason === "stop" ? result : undefined;
			}),
	};
}