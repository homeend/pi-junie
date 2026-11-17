// Neutral domain types shared by the ACP driver and the Pi bridge.
// No ACP and no Pi concepts here: plain data only.

export interface AgentIdentity {
	name: string;
	title: string;
	version: string;
}

/** Who connected to us (from the protocol handshake), protocol-agnostic. */
export interface ClientProfile {
	name: string;
	title?: string;
	version?: string;
	/** Product-specific feature flags the client says it understands (e.g. AIR capability strings). */
	features: string[];
}

/** A fixed provider slot the agent can route through an external endpoint. */
export interface ProviderSlot {
	id: string; // "anthropic" | "openai" | "google" ...
	displayName: string;
	/** API dialects the slot accepts, e.g. ["anthropic"], ["google", "vertex"]. */
	supportedApiTypes: string[];
	required: boolean;
}

/** The client told us to route a slot through this endpoint. */
export interface ProviderBinding {
	slotId: string;
	apiType: string;
	baseUrl: string;
	headers: Record<string, string>;
}

export interface ProviderSlotState extends ProviderSlot {
	binding?: ProviderBinding;
}

/** Stable reference to a model: which slot it goes through and the model id in that slot. */
export interface ModelRef {
	slotId: string;
	modelId: string;
}

export interface ModelChoice extends ModelRef {
	name: string;
	description?: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface ModelGroup {
	slotId: string;
	name: string;
	models: ModelChoice[];
}

export type TurnEvent =
	| { kind: "text"; delta: string }
	| { kind: "thought"; delta: string }
	| { kind: "usage"; inputTokens: number; outputTokens: number; contextUsed?: number; contextSize?: number; costUsd?: number }
	| { kind: "title"; title: string };

export type TurnStop = "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error";

export interface TurnResult {
	stop: TurnStop;
	error?: string;
	usage?: { inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number };
}
