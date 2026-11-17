// Translation between ACP v1 wire shapes and core types. Pure functions.

import type { ClientProfile, ModelGroup, ModelRef, ProviderBinding, ProviderSlotState, TurnEvent, TurnResult } from "../core/types.ts";
import { RpcError } from "./jsonrpc.ts";
import type {
	ContentBlock,
	InitializeParams,
	ProviderListEntry,
	ProvidersSetParams,
	SelectConfigOption,
	SelectGroup,
	SessionUpdate,
} from "./wire.ts";

export const MODEL_CONFIG_ID = "model";
const MODEL_VALUE_PREFIX = "pi:";

// --- initialize -----------------------------------------------------------------------------

export function decodeClientProfile(params: InitializeParams): ClientProfile {
	const air = params.clientCapabilities?._meta?.jetbrains?.air;
	const features = typeof air?.version === "number" && air.version >= 1 && Array.isArray(air.capabilities) ? air.capabilities.filter((c) => typeof c === "string") : [];
	return {
		name: params.clientInfo?.name ?? "unknown",
		title: params.clientInfo?.title,
		version: params.clientInfo?.version,
		features,
	};
}

export function isAirClient(profile: ClientProfile): boolean {
	return profile.name.startsWith("air-plugin:");
}

// --- providers ------------------------------------------------------------------------------

export function encodeProviderList(slots: ProviderSlotState[]): { providers: ProviderListEntry[] } {
	return {
		providers: slots.map((s) => ({
			providerId: s.id,
			supported: s.supportedApiTypes,
			required: s.required,
			current: s.binding ? { apiType: s.binding.apiType, baseUrl: s.binding.baseUrl } : null,
		})),
	};
}

export function decodeProviderBinding(params: ProvidersSetParams, slots: ProviderSlotState[]): ProviderBinding {
	if (!params?.providerId || !params.apiType || !params.baseUrl) throw RpcError.invalidParams("providerId, apiType and baseUrl are required");
	const slot = slots.find((s) => s.id === params.providerId);
	if (!slot) throw RpcError.invalidParams(`Unknown provider: ${params.providerId}`);
	if (!slot.supportedApiTypes.includes(params.apiType)) {
		throw RpcError.invalidParams(`Provider ${params.providerId} does not support apiType ${params.apiType}`);
	}
	return { slotId: params.providerId, apiType: params.apiType, baseUrl: params.baseUrl, headers: params.headers ?? {} };
}

// --- models as config option ----------------------------------------------------------------

export function encodeModelValue(ref: ModelRef): string {
	return `${MODEL_VALUE_PREFIX}${ref.slotId}/${ref.modelId}`;
}

export function decodeModelValue(value: string): ModelRef {
	if (!value.startsWith(MODEL_VALUE_PREFIX) || !value.includes("/")) throw RpcError.invalidParams(`Unknown model value: ${value}`);
	const rest = value.slice(MODEL_VALUE_PREFIX.length);
	const slash = rest.indexOf("/");
	return { slotId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

/** Builds the `configOptions` array. Returns no model option when no model is reachable. */
export function encodeConfigOptions(groups: ModelGroup[], current: ModelRef | undefined): SelectConfigOption[] {
	const nonEmpty = groups.filter((g) => g.models.length > 0);
	if (nonEmpty.length === 0) return [];
	const options: SelectGroup[] = nonEmpty.map((g) => ({
		group: `proxy:${g.slotId}`,
		name: g.name,
		options: g.models.map((m) => ({ value: encodeModelValue(m), name: m.name, description: m.description ?? "" })),
	}));
	const fallback = nonEmpty[0].models[0];
	return [
		{
			type: "select",
			id: MODEL_CONFIG_ID,
			name: "Model",
			description: "Select the model Pi uses for responses",
			category: "model",
			currentValue: encodeModelValue(current ?? fallback),
			options,
		},
	];
}

// --- prompt ---------------------------------------------------------------------------------

export function decodePromptText(prompt: ContentBlock[] | undefined): string {
	if (!Array.isArray(prompt)) throw RpcError.invalidParams("prompt must be an array of content blocks");
	return prompt
		.map((b) => {
			if (b.type === "text") return String((b as { text: string }).text);
			if (b.type === "resource_link") return `[${String(b.name ?? b.uri)}](${String(b.uri)})`;
			if (b.type === "resource") {
				const r = b.resource as { uri?: string; text?: string } | undefined;
				return r?.text ? `<context uri="${r.uri ?? ""}">\n${r.text}\n</context>` : "";
			}
			return ""; // images/audio: not supported yet (promptCapabilities says so)
		})
		.filter(Boolean)
		.join("\n\n");
}

export function encodeTurnEvent(event: TurnEvent): SessionUpdate | undefined {
	switch (event.kind) {
		case "text":
			return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } };
		case "thought":
			return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } };
		case "title":
			return { sessionUpdate: "session_info_update", title: event.title };
		case "usage":
			if (event.contextUsed === undefined || event.contextSize === undefined) return undefined;
			return {
				sessionUpdate: "usage_update",
				used: event.contextUsed,
				size: event.contextSize,
				...(event.costUsd !== undefined ? { cost: { amount: event.costUsd, currency: "USD" } } : {}),
			};
	}
}

export function encodePromptResult(result: TurnResult): Record<string, unknown> {
	const stopReason = result.stop === "error" ? "end_turn" : result.stop;
	return {
		stopReason,
		...(result.usage
			? {
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
						totalTokens: result.usage.inputTokens + result.usage.outputTokens,
						cachedReadTokens: result.usage.cachedReadTokens ?? 0,
						cachedWriteTokens: result.usage.cachedWriteTokens ?? 0,
					},
				}
			: {}),
	};
}
