// Raw ACP v1 wire shapes as AIR and Junie use them, including JetBrains `_meta` extensions.
// Only the fields this agent reads or writes are modelled. Nothing outside src/acp may import this.

export const PROTOCOL_VERSION = 1;

export interface AirMetaEnvelope {
	version: number;
	capabilities?: string[];
	[key: string]: unknown;
}
export interface WithMeta {
	_meta?: { jetbrains?: { air?: AirMetaEnvelope }; [key: string]: unknown };
}

export interface InitializeParams {
	protocolVersion: number;
	clientCapabilities?: { _meta?: { jetbrains?: { air?: AirMetaEnvelope }; terminal_output_delta?: unknown; terminal_output?: unknown; [key: string]: unknown } } & Record<string, unknown>;
	clientInfo?: { name: string; title?: string; version?: string };
}

export interface InitializeResult extends WithMeta {
	protocolVersion: number;
	agentCapabilities: WithMeta & Record<string, unknown>;
	authMethods: unknown[];
	agentInfo: { name: string; title: string; version: string };
}

export interface ProviderListEntry {
	providerId: string;
	supported: string[];
	required: boolean;
	current: { apiType: string; baseUrl: string } | null;
}

export interface ProvidersSetParams extends WithMeta {
	providerId: string;
	apiType: string;
	baseUrl: string;
	headers?: Record<string, string>;
}

export interface SelectOption extends WithMeta {
	value: string;
	name: string;
	description?: string;
}
export interface SelectGroup extends WithMeta {
	group: string;
	name: string;
	options: SelectOption[];
}
export interface SelectConfigOption extends WithMeta {
	type: "select";
	id: string;
	name: string;
	description?: string;
	category?: string;
	currentValue: string;
	options: SelectOption[] | SelectGroup[];
}

/** A boolean session config option (Junie's `eco`). */
export interface BooleanConfigOption extends WithMeta {
	type: "boolean";
	id: string;
	name: string;
	description?: string;
	category?: string;
	currentValue: boolean;
}

export type ConfigOption = SelectConfigOption | BooleanConfigOption;

export type ContentBlock = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface SessionPromptParams {
	sessionId: string;
	prompt: ContentBlock[];
}

export type SessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string }; messageId?: string; _meta?: Record<string, unknown> }
	| { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string }; messageId?: string }
	| { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
	| { sessionUpdate: "session_info_update"; title?: string; _meta?: Record<string, unknown> }
	| { sessionUpdate: "available_commands_update"; availableCommands: Record<string, unknown>[] }
	| { sessionUpdate: "tool_call"; toolCallId: string; [key: string]: unknown }
	| { sessionUpdate: "tool_call_update"; toolCallId: string; [key: string]: unknown }
	// Standard ACP plan (one per session, full snapshot) and Junie's v1 id'd plans for clients with `plan` capability.
	| { sessionUpdate: "plan"; entries: { content: string; priority: string; status: string }[] }
	| { sessionUpdate: "plan_update"; plan: { type: "items"; id: string; entries: { content: string; priority: string; status: string }[] } | { type: "markdown"; id: string; content: string } }
	| { sessionUpdate: "plan_removed"; id: string }
	| { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
	// AIR native subagent sessions (ACP draft "Subagent Sessions", sent on the parent session; the child's own
	// updates are ordinary updates addressed to subagentSessionId).
	| { sessionUpdate: "subagent_spawned"; subagentSessionId: string; name: string; task: string; prompt?: string; capabilities: { cancel: boolean; close: boolean } }
	| { sessionUpdate: "subagent_state_update"; subagentSessionId: string; state: "completed" | "failed" | "cancelled" | "disconnected" };
