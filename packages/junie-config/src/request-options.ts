/**
 * Request options Junie applies to the body of every request (plan steps 3 and 4).
 *
 * A custom model profile's `extraBody` is merged into the top level of the request JSON and wins over fields already
 * set, and its `temperature` is sent when declared (documentation/topics/Custom-LLM-models.md, "Extra body" and
 * "Temperature"). Google's API takes the temperature in `generationConfig`.
 */
import { mergeBody, type ProfileModel } from "./profiles.ts";

export function withProfileOptions(payload: unknown, model: ProfileModel): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	let body = { ...(payload as Record<string, unknown>) };
	if (model.temperature !== undefined) body = withTemperature(body, model.apiType === "Google", model.temperature);
	return model.extraBody ? mergeBody(body, model.extraBody) : body;
}

export function withTemperature(body: Record<string, unknown>, google: boolean, temperature: number): Record<string, unknown> {
	if (!google) return { ...body, temperature };
	const config = typeof body.generationConfig === "object" && body.generationConfig !== null ? body.generationConfig : {};
	return { ...body, generationConfig: { ...config, temperature } };
}
