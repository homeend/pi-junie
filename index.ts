// Pi extension entry point. Edit, then run /reload inside Pi.
// Docs: ../pi/packages/coding-agent/docs/extensions.md
// Examples: ../pi/packages/coding-agent/examples/extensions/

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Lifecycle event
	pi.on("session_start", async (event, ctx) => {
		ctx.ui.setStatus("pi-junie", `pi-junie loaded (${event.reason})`);
		ctx.ui.setWidget("pi-junie", ["pi-junie extension active — try /hello or ask the model to greet someone"]);
		ctx.ui.notify("pi-junie extension loaded", "info");
	});

	// Slash command: /hello [name]
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify(`Hello ${args.trim() || "world"}!`, "info");
		},
	});

	// Tool the LLM can call
	pi.registerTool({
		name: "greet",
		label: "Greet",
		description: "Greet someone by name",
		parameters: Type.Object({
			name: Type.String({ description: "Name to greet" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});
}
