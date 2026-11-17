// Junie compatibility profile: things done only so AIR's Junie-oriented assets work unchanged in Pi.
//
// IDE router alias. AIR's IDE MCP server (`jetbrains_air_ide`) offers one router tool, `execute_tool`,
// and AIR's IDE skills (ij-debugger, database-connection-management, ...) are written for Junie, where the
// model sees that router as plain `execute_tool` with Junie's wrapper description
// (junie-agent: IjEmbeddedExecuteToolAgentAction, BaseMcpAwareActionsResolver). Pi would expose it as
// `mcp__jetbrains_air_ide__execute_tool`. With the alias on:
//   - the MCP router stays registered but is not declared to the model (exposure `codemode`: callable only);
//   - Pi gets a tool named exactly `execute_tool` with Junie's description, forwarding to the router;
//   - the forwarded (nested) call is neither asked for again nor shown as a second tool card.
// Switch off with PI_AIR_JUNIE_EXECUTE_TOOL=0 (then Pi sees the router under its MCP name).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface JunieCompatOptions {
	/** Expose AIR's IDE router as `execute_tool` like Junie does. */
	executeToolAlias: boolean;
}

export const JUNIE_COMPAT_DEFAULTS: JunieCompatOptions = { executeToolAlias: true };

export const IDE_SERVER = "jetbrains_air_ide";
export const IDE_ROUTER_TOOL = "execute_tool";
/** Pi's name for the router when it is reached through MCP directly. */
export const IDE_ROUTER_MCP_NAME = `mcp__${IDE_SERVER}__${IDE_ROUTER_TOOL}`;

/** Junie's wrapper description (IjEmbeddedExecuteToolAgentAction.WRAPPER_DESCRIPTION), verbatim. */
export const JUNIE_EXECUTE_TOOL_DESCRIPTION =
	"Controls the connected JetBrains IDE. Use only when explicitly instructed by the user or by a skill you have already read because it is relevant to the user's task. Do not search for or read skills solely to find instructions or permission to use this tool. If neither the user nor a task-relevant skill instructs you to use it, do not call it.";

/** Name the model uses for the IDE router under the given options. */
export function ideRouterName(options: JunieCompatOptions): string {
	return options.executeToolAlias ? IDE_ROUTER_TOOL : IDE_ROUTER_MCP_NAME;
}

/** MCP exposure for the IDE server: with the alias, its router is callable but not declared to the model. */
export function ideServerToolExposure(options: JunieCompatOptions): Record<string, "codemode"> | undefined {
	return options.executeToolAlias ? { [IDE_ROUTER_TOOL]: "codemode" } : undefined;
}

/** Pi extension adding the `execute_tool` alias (only when the alias is on and the IDE server is present). */
export function junieExecuteToolAlias(pi: ExtensionAPI): void {
	pi.registerTool({
		name: IDE_ROUTER_TOOL,
		label: "IDE",
		description: JUNIE_EXECUTE_TOOL_DESCRIPTION,
		parameters: Type.Object({
			command: Type.String({ description: "Command-line string with tool name and arguments" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool(IDE_ROUTER_MCP_NAME, { command: params.command }, { signal });
			return {
				content: outcome.result.content,
				details: outcome.result.details,
				...(outcome.isError ? { isError: true } : {}),
			};
		},
	});
}
