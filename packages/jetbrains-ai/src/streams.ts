import type { ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";

/** Normalize model-specific constraints observed on the Ingrazzio routes. */
export function jetbrainsStreams(api: ProviderStreams): ProviderStreams {
	function optionsWithCompatibility(options?: StreamOptions): StreamOptions {
		return {
			...options,
			async onPayload(payload, model) {
				if (typeof payload === "object" && payload !== null) {
					const body = payload as Record<string, unknown>;
					if (["gpt-5-2025-08-07", "gpt-6-astra", "gpt-6.1-sol"].includes(model.id)) {
						const reasoning = body.reasoning;
						if (
							typeof reasoning === "object" &&
							reasoning !== null &&
							"effort" in reasoning &&
							reasoning.effort === "none"
						)
							reasoning.effort = "low";
					}
					if (
						[
							"claude-opus-4-6",
							"claude-opus-4-7",
							"claude-opus-4-8",
							"claude-opus-5",
							"claude-sonnet-5",
							"claude-opus-5-5",
							"claude-fable-5",
							"claude-fable-5-1",
							"claude-sonnet-5-5",
						].includes(model.id)
					) {
						const thinking = body.thinking;
						if (
							thinking === undefined ||
							(typeof thinking === "object" &&
								thinking !== null &&
								"type" in thinking &&
								(thinking.type === "disabled" || thinking.type === "enabled"))
						) {
							body.thinking = {
								type:
									model.id === "claude-sonnet-5-5" &&
									typeof thinking === "object" &&
									thinking !== null &&
									"type" in thinking &&
									thinking.type === "disabled"
										? "between_tools"
										: "adaptive",
							};
						}
					}
				}
				return (await options?.onPayload?.(payload, model)) ?? payload;
			},
		};
	}
	return {
		stream: (model, context, options) => api.stream(model, context, optionsWithCompatibility(options)),
		streamSimple: (model, context, options) =>
			api.streamSimple(model, context, { ...options, ...optionsWithCompatibility(options) }),
	};
}
