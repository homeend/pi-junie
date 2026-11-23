import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The first of `ids`, in order of preference, among the available models of `provider`, i.e. the ones Pi has
 * credentials for. Gateway ids with a vendor prefix (`anthropic/claude-haiku-5-5`) match too.
 */
export function firstAvailable(
	ctx: ExtensionContext, provider: string, ids: readonly string[],
): Model<Api> | undefined {
	const available = ctx.modelRegistry.getAvailable().filter((model) => model.provider === provider);
	return ids.map((id) => available.find((model) => model.id === id || model.id.endsWith(`/${id}`)))
		.find((model) => model !== undefined);
}
