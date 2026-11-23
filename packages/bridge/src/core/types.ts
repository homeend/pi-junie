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
	/** The client shows question forms (ACP elicitation, form mode). */
	questionForms?: boolean;
	/** The client takes plan updates with ids (several plans, removal) instead of the single legacy plan. */
	planUpdates?: boolean;
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
	/**
	 * A real vendor key (Junie's `JUNIE_<VENDOR>_API_KEY`) when the binding goes straight to the vendor rather than
	 * through a proxy that authenticates by `headers`. Never logged.
	 */
	apiKey?: string;
	/** Vertex resource location the client names for a vertex binding (else the proxy's placeholders apply). */
	vertex?: { projectId: string; location: string };
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
	/** The model accepts Eco mode (Junie's Model Mix) at some effort. */
	eco?: boolean;
}

/** A preset level of the Default model group (Junie's mixes): a model and an effort under one name. */
export interface ModelMix {
	id: string;
	label: string;
	description: string;
	model: ModelRef;
	/** Name of the level's model, shown by clients in place of the level name. */
	modelName: string;
	/** The level's effort; undefined when the model takes none. */
	effort?: string;
	/** The level new sessions start on. */
	recommended: boolean;
	/** The level runs in Eco mode (Junie's Model Mix). */
	eco?: boolean;
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
	/**
	 * `new_session` is handled by the client itself; `skill` runs one of the session's skills; `plan_mode` switches
	 * plan mode on (`/plan [task]`, `/plan off`), which clients may show as a toggle.
	 */
	kind: "builtin" | "skill" | "new_session" | "plan_mode";
	skillPath?: string;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** Upsert of one tool call: the first update for an id creates it, later ones change it. */
export interface ToolUpdate {
	id: string;
	name: string;
	/** The tool starts a subagent (whose child session clients may show instead of this row). */
	launchesSubagent?: boolean;
	/** The tool only updates the plan (shown as the plan, not as a tool row). */
	presentsPlan?: boolean;
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
	/** Set when a subagent (child session) wants to run the tool. */
	subagentId?: string;
}

/**
 * How tool calls are approved (Junie's Brave Mode): "safe" asks for everything not known to be read-only, "auto" also
 * runs read-only shell commands without asking, "brave" runs everything without asking.
 */
export type ApprovalMode = "safe" | "auto" | "brave";

export type PermissionDecision = "allow_once" | "allow_always" | "reject";

export type TurnEvent =
	| { kind: "text"; delta: string; phase?: MessagePhase }
	| { kind: "thought"; delta: string }
	| { kind: "usage"; inputTokens: number; outputTokens: number; contextUsed?: number; contextSize?: number; costUsd?: number }
	| { kind: "title"; title: string }
	| { kind: "tool"; update: ToolUpdate }
	| { kind: "plan"; plan: PlanUpdate }
	/** Session settings changed during the turn (e.g. plan mode switched): the client should refresh them. */
	| { kind: "settings_changed" }
	| SubagentEvent;

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** One step of a plan (a todo item). */
export interface PlanEntry {
	content: string;
	status: PlanEntryStatus;
	priority: "high" | "medium" | "low";
}

/**
 * The agent's plan, always a full snapshot: the current entries of plan `id` (a todo list), a Markdown plan (a plan
 * written in plan mode, for the user to review), or its removal.
 */
export type PlanUpdate =
	| { kind: "items"; id: string; entries: PlanEntry[] }
	| { kind: "markdown"; id: string; content: string }
	| { kind: "removed"; id: string };

/** A finished plan the user reviews before the agent implements it. */
export interface PlanReview {
	planId: string;
	markdown: string;
}

/** The user's verdict on a plan: build it now, keep planning (their next message revises it), or leave plan mode. */
export type PlanDecision = "implement" | "revise" | "stop";

/**
 * A subagent: a child agent session the turn started, with its own transcript. `subagentId` is unique per process;
 * the child's own events arrive wrapped in `subagent_update` (never a usage or title of the parent).
 */
export type SubagentEvent =
	| { kind: "subagent_spawned"; subagentId: string; name: string; task: string; prompt?: string }
	| { kind: "subagent_update"; subagentId: string; event: TurnEvent }
	| { kind: "subagent_finished"; subagentId: string; state: SubagentState };

export type SubagentState = "completed" | "failed" | "cancelled";

/** "commentary": text the agent writes while working (before tool calls); "final_answer": its answer. */
export type MessagePhase = "commentary" | "final_answer";

export type TurnStop = "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error";

/** Why a turn failed, for the client's failure row: a broad group, one line, optional explanation, and recovery. */
export interface TurnFailure {
	category: "connection" | "access" | "limit" | "request" | "service" | "unknown";
	title: string;
	details?: string;
	actions: ("retry" | "login" | "new_session")[];
}

export interface TurnResult {
	stop: TurnStop;
	error?: string;
	failure?: TurnFailure;
	usage?: { inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number };
}

/**
 * What happened to a message sent while a turn runs (steering):
 * "injected" the running turn takes it; "not_running" no turn is running (the caller starts one);
 * "busy" the running turn cannot take messages now (a command runs, or the message is a command that starts its own turn).
 */
export type SteerResult = "injected" | "not_running" | "busy";

/** One question the agent asks the user: free text, or a choice among options (with free text as "Other"). */
export interface Question {
	/** Short human-readable label, e.g. "Tech stack". */
	name: string;
	question?: string;
	options?: { title: string; description?: string }[];
	allowMultiple?: boolean;
}

/** Questions asked together in one form; `context` is shown before them. */
export interface QuestionForm {
	questions: Question[];
	context?: string;
}

/** The user's reply to a form: per question (same order) the chosen option titles and/or own text. */
export type QuestionAnswers =
	| { action: "accept"; answers: { selected: string[]; text?: string }[] }
	| { action: "decline" }
	| { action: "cancel" };

/** A saved session as shown in the client's history. */
export interface SessionSummary {
	id: string;
	cwd: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	lastPromptAt?: string;
	/** The session this one was forked from. */
	forkedFrom?: string;
}

/** One past item of a conversation, replayed when a client reopens a session. */
export type HistoryItem =
	| { kind: "user"; text: string; imageCount: number }
	| { kind: "assistant"; text: string; phase?: MessagePhase }
	| { kind: "thought"; text: string }
	| { kind: "tool"; update: ToolUpdate }
	| { kind: "plan"; plan: PlanUpdate };

/** A tool server (MCP) the client wants the agent to use in a session, e.g. the IDE's own server. */
export type McpServerSpec =
	| { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
	| { name: string; transport: "http"; url: string; headers: Record<string, string> };
