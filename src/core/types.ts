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
	/** The client renders live terminal output from deltas. */
	liveTerminal: boolean;
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
	/** Model ids the user picked in the client for this provider, in order (narrows a discovered account catalog). */
	selectedModels?: string[];
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

export interface PromptImage {
	/** base64 */
	data: string;
	mimeType: string;
}

/** One user turn: text plus optional images; `command` when the user invoked one of the session's commands. */
export interface PromptInput {
	text: string;
	images: PromptImage[];
	command?: { name: string; args: string };
}

/** A command the session offers (shown in the client's command popup). */
export interface CommandInfo {
	name: string;
	description: string;
	/** Placeholder for free-text arguments; absent when the command takes none. */
	hint?: string;
	/** `new_session` is handled by the client itself; `skill` runs one of the session's skills. */
	kind: "builtin" | "skill" | "new_session";
	skillPath?: string;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** Upsert of one tool call: the first update for an id creates it, later ones change it. */
export interface ToolUpdate {
	id: string;
	name: string;
	title?: string;
	toolKind?: ToolKind;
	status?: ToolStatus;
	input?: unknown;
	locations?: { path: string; line?: number }[];
	/** Full text output so far (replaces earlier output). */
	output?: string;
	diff?: { path: string; oldText: string | null; newText: string };
	/** A command running in a terminal: output arrives as deltas, the exit code at the end. */
	terminal?: { command: string; cwd: string; delta?: string; exitCode?: number };
}

export interface PermissionRequest {
	toolCallId: string;
	toolName: string;
	title: string;
	toolKind: ToolKind;
	input: unknown;
	locations?: { path: string; line?: number }[];
}

export type PermissionDecision = "allow_once" | "allow_always" | "reject";

export type TurnEvent =
	| { kind: "text"; delta: string }
	| { kind: "thought"; delta: string }
	| { kind: "usage"; inputTokens: number; outputTokens: number; contextUsed?: number; contextSize?: number; costUsd?: number }
	| { kind: "title"; title: string }
	| { kind: "tool"; update: ToolUpdate };

export type TurnStop = "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error";

export interface TurnResult {
	stop: TurnStop;
	error?: string;
	usage?: { inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number };
}

/**
 * What happened to a message sent while a turn runs (steering):
 * "injected" the running turn takes it; "not_running" no turn is running (the caller starts one);
 * "busy" the running turn cannot take messages now (a command runs, or the message is a command that starts its own turn).
 */
export type SteerResult = "injected" | "not_running" | "busy";

/** A saved session as shown in the client's history. */
export interface SessionSummary {
	id: string;
	cwd: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	lastPromptAt?: string;
}

/** One past item of a conversation, replayed when a client reopens a session. */
export type HistoryItem =
	| { kind: "user"; text: string; imageCount: number }
	| { kind: "assistant"; text: string }
	| { kind: "thought"; text: string }
	| { kind: "tool"; update: ToolUpdate };

/** A tool server (MCP) the client wants the agent to use in a session, e.g. the IDE's own server. */
export type McpServerSpec =
	| { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
	| { name: string; transport: "http"; url: string; headers: Record<string, string> };
