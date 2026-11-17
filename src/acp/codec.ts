// Translation between ACP v1 wire shapes and core types. Pure functions.

import type { ClientProfile, CommandInfo, HistoryItem, McpServerSpec, ModelGroup, ModelRef, PromptImage, PromptInput, ProviderBinding, PermissionDecision, PermissionRequest, ProviderSlotState, SessionSummary, ToolUpdate, TurnEvent, TurnResult, MessagePhase, TurnFailure } from "../core/types.ts";
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
export const EFFORT_CONFIG_ID = "effort";
const RECOMMENDED_EFFORT = "medium";
const EFFORT_LABELS: Record<string, string> = {
	off: "○ No reasoning",
	minimal: "◌ Minimal effort",
	low: "◎ Low effort",
	medium: "◐ Medium effort",
	high: "◕ High effort",
	xhigh: "● Extra high effort",
	max: "● Max effort",
};
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
		liveTerminal: params.clientCapabilities?._meta?.terminal_output_delta === true || params.clientCapabilities?._meta?.terminal_output === true,
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
	const selected = params._meta?.jetbrains?.air?.selectedModels;
	if (selected !== undefined && (!Array.isArray(selected) || selected.some((m) => typeof m !== "string"))) {
		throw RpcError.invalidParams("_meta.jetbrains.air.selectedModels must be an array of strings");
	}
	const vertex = params.apiType === "vertex" ? decodeVertexLocation(params._meta) : undefined;
	return {
		slotId: params.providerId,
		apiType: params.apiType,
		baseUrl: params.baseUrl,
		headers: params.headers ?? {},
		...(selected ? { selectedModels: selected as string[] } : {}),
		...(vertex ? { vertex } : {}),
	};
}

/** `_meta.vertex` (else `_meta.claudeCode.vertex`) `{projectId, location | region}`, like Junie. */
function decodeVertexLocation(meta: Record<string, any> | undefined): { projectId: string; location: string } | undefined {
	const raw = meta?.vertex ?? meta?.claudeCode?.vertex;
	if (raw === undefined) return undefined;
	const invalid = () => RpcError.invalidParams("_meta.vertex must be an object with string values");
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid();
	if (Object.values(raw).some((v) => typeof v !== "string")) throw invalid();
	const projectId = raw.projectId?.trim();
	const location = (raw.location ?? raw.region)?.trim();
	return projectId && location ? { projectId, location } : undefined;
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

export interface EffortState {
	levels: string[];
	current: string | undefined;
}

/** The `effort` select (Junie's shape: category `thought_level`, AIR `recommendedValue`); none when the model can't reason. */
export function encodeEffortOption(effort: EffortState | undefined): SelectConfigOption[] {
	if (!effort || effort.levels.length === 0) return [];
	const recommended = effort.levels.includes(RECOMMENDED_EFFORT) ? RECOMMENDED_EFFORT : effort.levels[0];
	return [
		{
			type: "select",
			id: EFFORT_CONFIG_ID,
			name: "Effort",
			description: "Select how much reasoning effort Pi spends for the selected model",
			category: "thought_level",
			currentValue: effort.current && effort.levels.includes(effort.current) ? effort.current : recommended,
			options: effort.levels.map((l) => ({ value: l, name: EFFORT_LABELS[l] ?? l })),
			_meta: { jetbrains: { air: { version: 1, recommendedValue: recommended } } },
		} as SelectConfigOption,
	];
}

/** Builds the `configOptions` array. Returns no model option when no model is reachable. */
export function encodeConfigOptions(groups: ModelGroup[], current: ModelRef | undefined, effort?: EffortState): SelectConfigOption[] {
	const nonEmpty = groups.filter((g) => g.models.length > 0);
	if (nonEmpty.length === 0) return [];
	const options: SelectGroup[] = nonEmpty.map((g) => ({
		group: `proxy:${g.slotId}`,
		name: g.name,
		options: g.models.map((m) => ({ value: encodeModelValue(m), name: m.name, description: m.description ?? "" })),
	}));
	const fallback = nonEmpty[0].models[0];
	const modelOption: SelectConfigOption[] = [
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
	return [...modelOption, ...encodeEffortOption(effort)];
}

// --- prompt ---------------------------------------------------------------------------------

/** ACP prompt blocks -> text + images. Images without inline data are referenced by URI in the text. */
export function decodePrompt(prompt: ContentBlock[] | undefined): PromptInput {
	if (!Array.isArray(prompt)) throw RpcError.invalidParams("prompt must be an array of content blocks");
	const images: PromptImage[] = [];
	const text = prompt
		.map((b) => {
			if (b.type === "image") {
				const { data, mimeType, uri } = b as { data?: string; mimeType?: string; uri?: string };
				if (typeof data === "string" && data && typeof mimeType === "string") {
					images.push({ data, mimeType });
					return "";
				}
				return uri ? `[image: ${uri}]` : "";
			}
			if (b.type === "text") return String((b as { text: string }).text);
			if (b.type === "resource_link") return `[${String(b.name ?? b.uri)}](${String(b.uri)})`;
			if (b.type === "resource") {
				const r = b.resource as { uri?: string; text?: string } | undefined;
				return r?.text ? `<context uri="${r.uri ?? ""}">\n${r.text}\n</context>` : "";
			}
			return ""; // audio: not supported (promptCapabilities says so)
		})
		.filter(Boolean)
		.join("\n\n");
	return { text, images };
}

/**
 * Message phase like Junie: AIR reads `_meta.jetbrains.air.phase` (commentary = working, final_answer = answer);
 * Junie also sends the codex and junie keys for compatibility, so we do too.
 */
function phaseMeta(phase: MessagePhase | undefined): { _meta?: Record<string, unknown> } {
	if (!phase) return {};
	return { _meta: { codex: { phase }, jetbrains: { air: { phase } }, junie: { version: 1, phase } } };
}

export function encodeTurnEvent(event: TurnEvent): SessionUpdate | undefined {
	switch (event.kind) {
		case "tool":
			return undefined; // stateful, see encodeToolUpdate
		case "text":
			return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta }, ...phaseMeta(event.phase) };
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

/** AIR's typed failure row: `session_info_update` with `_meta.jetbrains.air.sessionFailure` (Junie v1 shape). */
export function encodeSessionFailure(id: string, failure: TurnFailure): SessionUpdate {
	const title = failure.title.split(/\r?\n/)[0].trim().slice(0, 240) || "The run stopped";
	return {
		sessionUpdate: "session_info_update",
		_meta: {
			jetbrains: {
				air: {
					version: 1,
					sessionFailure: {
						id,
						revision: 1,
						category: failure.category,
						severity: "error",
						title,
						...(failure.details?.trim() ? { details: failure.details.trim().slice(0, 2000) } : {}),
						actions: failure.actions,
					},
				},
			},
		},
	};
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

// --- session list / load ------------------------------------------------------------------

const LIST_DEFAULT = 50;
const LIST_MAX = 200;

/** AIR's v1 list filter `_meta.jetbrains.air.list.limit` (default 50, max 200, like Junie). */
export function decodeListLimit(params: Record<string, unknown>): number {
	const limit = (params._meta as any)?.jetbrains?.air?.list?.limit;
	return typeof limit === "number" && limit > 0 ? Math.min(limit, LIST_MAX) : LIST_DEFAULT;
}

export function encodeSessionSummary(s: SessionSummary): Record<string, unknown> {
	return {
		sessionId: s.id,
		cwd: s.cwd,
		...(s.title ? { title: s.title } : {}),
		updatedAt: s.updatedAt,
		_meta: { jetbrains: { air: { version: 1, archived: false, state: "idle", ...(s.lastPromptAt ? { lastPromptAt: s.lastPromptAt } : {}) } } },
	};
}

/** History replay for session/load (ACP: the agent streams the whole conversation before answering). */
export function encodeHistory(items: HistoryItem[]): SessionUpdate[] {
	const known = new Set<string>();
	return items.map((item): SessionUpdate => {
		switch (item.kind) {
			case "tool":
				return encodeToolUpdate(item.update, known);
			case "user": {
				const text = item.imageCount ? `${item.text}${item.text ? "\n\n" : ""}[${item.imageCount} image(s)]` : item.text;
				return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
			}
			case "assistant":
				return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text }, ...phaseMeta(item.phase) };
			case "thought":
				return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.text } };
		}
	});
}

// --- tools & permissions ------------------------------------------------------------------

function toolContent(u: ToolUpdate): unknown[] | undefined {
	if (u.diff) return [{ type: "diff", path: u.diff.path, oldText: u.diff.oldText, newText: u.diff.newText }];
	if (u.output !== undefined) return [{ type: "content", content: { type: "text", text: u.output } }];
	return undefined;
}

/**
 * First update for an id -> `tool_call`, later ones -> `tool_call_update` (only the fields that are set).
 * With `liveTerminal`, terminal tools use AIR's v1 envelope: terminal content on the call, then
 * `_meta.terminal_output_delta` / `_meta.terminal_exit` (see docs/junie AIR reference, "Terminal output").
 */
export function encodeToolUpdate(u: ToolUpdate, known: Set<string>, options: { liveTerminal?: boolean } = {}): SessionUpdate {
	if (options.liveTerminal && u.terminal) return encodeTerminalUpdate(u, known);
	const content = toolContent(u);
	const fields = {
		toolCallId: u.id,
		...(u.title !== undefined ? { title: u.title } : {}),
		...(u.toolKind !== undefined ? { kind: u.toolKind } : {}),
		...(u.status !== undefined ? { status: u.status } : {}),
		...(u.input !== undefined ? { rawInput: u.input } : {}),
		...(u.locations ? { locations: u.locations } : {}),
		...(content ? { content } : {}),
	};
	if (known.has(u.id)) return { sessionUpdate: "tool_call_update", ...fields } as SessionUpdate;
	known.add(u.id);
	return { sessionUpdate: "tool_call", title: u.name, kind: "other", status: "pending", ...fields } as SessionUpdate;
}

function encodeTerminalUpdate(u: ToolUpdate, known: Set<string>): SessionUpdate {
	const t = u.terminal!;
	const meta: Record<string, unknown> = {};
	if (t.delta) meta.terminal_output_delta = { data: t.delta, terminal_id: u.id };
	if (t.exitCode !== undefined) meta.terminal_exit = { exit_code: t.exitCode, signal: null, terminal_id: u.id };
	const fields = {
		toolCallId: u.id,
		...(u.title !== undefined ? { title: u.title } : {}),
		...(u.toolKind !== undefined ? { kind: u.toolKind } : {}),
		...(u.status !== undefined ? { status: u.status } : {}),
		...(u.output !== undefined && t.exitCode !== undefined ? { rawOutput: { output: u.output, exitCode: t.exitCode } } : {}),
		...(Object.keys(meta).length ? { _meta: meta } : {}),
	};
	if (known.has(u.id)) return { sessionUpdate: "tool_call_update", ...fields } as SessionUpdate;
	known.add(u.id);
	return {
		sessionUpdate: "tool_call",
		title: u.name,
		kind: "execute",
		status: "pending",
		...fields,
		rawInput: { command: t.command, cwd: t.cwd },
		content: [{ type: "terminal", terminalId: u.id }],
	} as SessionUpdate;
}

export const PERMISSION_OPTIONS = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Allow for this chat", kind: "allow_always" },
	{ optionId: "reject", name: "Reject", kind: "reject_once" },
] as const;

export function encodePermissionRequest(sessionId: string, r: PermissionRequest): Record<string, unknown> {
	return {
		sessionId,
		toolCall: {
			toolCallId: r.toolCallId,
			title: r.title,
			kind: r.toolKind,
			status: "pending",
			rawInput: r.input,
			...(r.locations ? { locations: r.locations } : {}),
		},
		options: PERMISSION_OPTIONS,
	};
}

/** `{outcome: {outcome: "selected", optionId}}` | `{outcome: {outcome: "cancelled"}}`; anything else rejects. */
export function decodePermissionOutcome(response: { outcome?: { outcome?: string; optionId?: string } } | undefined): PermissionDecision {
	const o = response?.outcome;
	if (o?.outcome !== "selected") return "reject";
	return o.optionId === "allow_once" || o.optionId === "allow_always" ? o.optionId : "reject";
}

// --- MCP servers --------------------------------------------------------------------------

function nameValueList(list: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (Array.isArray(list)) for (const e of list) if (typeof e?.name === "string" && typeof e?.value === "string") out[e.name] = e.value;
	return out;
}

/**
 * ACP `mcpServers` -> core specs. Stdio: `{name, command, args, env: [{name, value}]}` (type optional);
 * HTTP: `{type: "http", name, url, headers: [{name, value}]}`. SSE servers are skipped (Pi has no SSE transport).
 */
export function decodeMcpServers(list: unknown): { servers: McpServerSpec[]; skipped: string[] } {
	const servers: McpServerSpec[] = [];
	const skipped: string[] = [];
	if (!Array.isArray(list)) return { servers, skipped };
	for (const s of list as Record<string, unknown>[]) {
		const name = typeof s?.name === "string" ? s.name : undefined;
		if (!name) continue;
		if ((s.type === undefined || s.type === "stdio") && typeof s.command === "string") {
			servers.push({ name, transport: "stdio", command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: nameValueList(s.env) });
		} else if (s.type === "http" && typeof s.url === "string") {
			servers.push({ name, transport: "http", url: s.url, headers: nameValueList(s.headers) });
		} else skipped.push(`${name} (${String(s.type ?? "unknown")})`);
	}
	return { servers, skipped };
}

/**
 * Client skill roots: the standard `additionalDirectories` when present (an explicit empty list means none),
 * otherwise AIR's `_meta.additionalRoots`. Only absolute paths, without duplicates or the cwd itself.
 */
export function decodeSkillRoots(params: Record<string, unknown>, cwd: string): string[] {
	const standard = params.additionalDirectories;
	const meta = (params._meta as { additionalRoots?: unknown } | undefined)?.additionalRoots;
	const list = Array.isArray(standard) ? standard : Array.isArray(meta) ? meta : [];
	const out: string[] = [];
	for (const r of list) if (typeof r === "string" && r.startsWith("/") && r !== cwd && !out.includes(r)) out.push(r);
	return out;
}

// --- commands -----------------------------------------------------------------------------

/**
 * `available_commands_update` entries. Skills follow Junie/AIR: `$<skill>` plus AIR's live-session skill
 * decoration (`_meta.jetbrains.air.kind = "skill"`, `skillPath`), which Junie itself does not send.
 * `new` is AIR's own action (`commandAction: openNewSession`).
 */
export function encodeCommands(commands: CommandInfo[]): Record<string, unknown>[] {
	return commands.map((c) => {
		const input = c.hint ? { input: { type: "unstructured", hint: c.hint } } : {};
		switch (c.kind) {
			case "new_session":
				return { name: c.name, description: c.description, _meta: { jetbrains: { air: { commandAction: { kind: "openNewSession" } } } } };
			case "skill":
				return {
					name: `$${c.name}`,
					description: c.description,
					...input,
					_meta: { jetbrains: { air: { version: 1, kind: "skill", ...(c.skillPath ? { skillPath: c.skillPath } : {}) } } },
				};
			default:
				return { name: c.name, description: c.description, ...input };
		}
	});
}

/** `/name args` (built-ins, skills) or `$name args` (skills) at the start of a prompt -> the invoked command. */
export function decodeCommand(text: string, commands: CommandInfo[]): { name: string; args: string } | undefined {
	const m = /^\s*([/$])(?:skill:)?([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!m) return undefined;
	const [, sigil, name, args = ""] = m;
	const command = commands.find((c) => c.name === name && c.kind !== "new_session");
	if (!command || (sigil === "$" && command.kind !== "skill")) return undefined;
	return { name, args: args.trim() };
}
