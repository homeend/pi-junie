// Ports: what the protocol side needs from an agent implementation.
// The ACP driver depends on these interfaces; the Pi bridge implements them.

import type { AgentIdentity, ModelGroup, ModelRef, PromptInput, ProviderBinding, ProviderSlotState, TurnEvent, TurnResult } from "./types.ts";

export type TurnSink = (event: TurnEvent) => void;

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
	prompt(input: PromptInput, sink: TurnSink, signal: AbortSignal): Promise<TurnResult>;
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
	openSession(request: { cwd: string }): Promise<BackendSession>;
	/**
	 * Reopens a session persisted by an earlier agent process. When nothing was saved under that id, continues it
	 * as an empty session with the same id (`restored: false`). Returns undefined only for an invalid id.
	 */
	resumeSession(request: { sessionId: string; cwd: string }): Promise<{ session: BackendSession; restored: boolean } | undefined>;
	/** Names + versions of installed agent-side plugins, for the compatibility layer. */
	installedPlugins(): { name: string; version?: string }[];
}
