// Ports: what the protocol side needs from an agent implementation.
// The ACP driver depends on these interfaces; the Pi bridge implements them.

import type { AgentIdentity, CommandInfo, ModelGroup, ModelRef, HistoryItem, McpServerSpec, PermissionDecision, PermissionRequest, PromptInput, ProviderBinding, ProviderSlotState, QuestionAnswers, QuestionForm, SessionSummary, SteerResult, TurnEvent, TurnResult } from "./types.ts";

export type TurnSink = (event: TurnEvent) => void;

/** What the client provides when it opens or reopens a session. */
export interface SessionContext {
	cwd: string;
	/** Tool servers to connect for this session (e.g. the IDE's own). */
	mcpServers?: McpServerSpec[];
	/** Extra directories whose `.agents/skills` and `.junie/skills` hold client-provided skills. */
	skillRoots?: string[];
	/** The client can show question forms, so the agent may ask the user (QuestionAsk). */
	questionForms?: boolean;
}
/** Asks the user questions through a client form; resolves with the answers, a decline, or a cancel. */
export type QuestionAsk = (form: QuestionForm, signal: AbortSignal) => Promise<QuestionAnswers>;

/** Asks the user (through the client) whether a tool call may run. */
export type PermissionAsk = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface BackendSession {
	readonly id: string;
	readonly cwd: string;
	currentModel(): ModelRef | undefined;
	selectModel(ref: ModelRef): Promise<void>;
	/** Reasoning effort levels the current model supports, weakest first (empty: no reasoning control). */
	effortLevels(): string[];
	currentEffort(): string | undefined;
	selectEffort(level: string): Promise<void>;
	/** Runs one user turn. Streams events to `sink`; resolves when the turn has finished. */
	prompt(input: PromptInput, sink: TurnSink, signal: AbortSignal, ask: PermissionAsk, askUser?: QuestionAsk): Promise<TurnResult>;
	/** Adds a message to the running turn (the user typed while the agent works). Never starts a turn itself. */
	steer(input: PromptInput): Promise<SteerResult>;
	/** Commands for the client's command popup (built-ins and skills). */
	commands(): Promise<CommandInfo[]>;
	/** The conversation so far (active branch), oldest first. */
	history(): HistoryItem[];
	title(): string | undefined;
	close(): Promise<void>;
}

export interface AgentBackend {
	identity(): AgentIdentity;
	providerSlots(): ProviderSlotState[];
	bindProvider(binding: ProviderBinding): void;
	unbindProvider(slotId: string): void;
	/** Models reachable right now (only slots with a binding). */
	availableModels(): ModelGroup[];
	/** Resolves when pending model discovery has finished, or after `timeoutMs`. */
	modelsSettled(timeoutMs: number): Promise<void>;
	/** Called whenever availableModels() may have changed. */
	onModelsChanged(listener: () => void): () => void;
	openSession(request: SessionContext): Promise<BackendSession>;
	/**
	 * Reopens a session persisted by an earlier agent process. When nothing was saved under that id, continues it
	 * as an empty session with the same id (`restored: false`). Returns undefined only for an invalid id.
	 */
	resumeSession(request: SessionContext & { sessionId: string }): Promise<{ session: BackendSession; restored: boolean } | undefined>;
	/** Saved sessions, newest first, optionally only those of one working directory. */
	listSessions(request: { cwd?: string; limit: number }): SessionSummary[];
	/** Names + versions of installed agent-side plugins, for the compatibility layer. */
	installedPlugins(): { name: string; version?: string }[];
}
