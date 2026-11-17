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
	clientCapabilities?: WithMeta & Record<string, unknown>;
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

export type ContentBlock = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface SessionPromptParams {
	sessionId: string;
	prompt: ContentBlock[];
}

export type SessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
	| { sessionUpdate: "config_option_update"; configOptions: SelectConfigOption[] }
	| { sessionUpdate: "session_info_update"; title?: string }
	| { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } };
