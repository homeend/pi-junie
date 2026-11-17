// Ports: what the protocol side needs from an agent implementation.
// The ACP driver depends on these interfaces; the Pi bridge implements them.

import type { AgentIdentity, ModelGroup, ModelRef, ProviderBinding, ProviderSlotState, TurnEvent, TurnResult } from "./types.ts";

export type TurnSink = (event: TurnEvent) => void;

export interface BackendSession {
	readonly id: string;
	readonly cwd: string;
	currentModel(): ModelRef | undefined;
	selectModel(ref: ModelRef): Promise<void>;
	/** Runs one user turn. Streams events to `sink`; resolves when the turn has finished. */
	prompt(text: string, sink: TurnSink, signal: AbortSignal): Promise<TurnResult>;
	close(): Promise<void>;
}

export interface AgentBackend {
	identity(): AgentIdentity;
	providerSlots(): ProviderSlotState[];
	bindProvider(binding: ProviderBinding): void;
	unbindProvider(slotId: string): void;
	/** Models reachable right now (only slots with a binding). */
	availableModels(): ModelGroup[];
	/** Called whenever availableModels() may have changed. */
	onModelsChanged(listener: () => void): () => void;
	openSession(request: { cwd: string }): Promise<BackendSession>;
	/** Names + versions of installed agent-side plugins, for the compatibility layer. */
	installedPlugins(): { name: string; version?: string }[];
}
