// Pi error texts -> neutral failures (src/pi/failures.ts).
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/pi/failures.ts";

describe("classifyFailure", () => {
	it("maps provider statuses to Junie's categories and recovery actions", () => {
		const of = (m: string) => {
			const f = classifyFailure(m);
			return [f.category, f.actions.join(",")];
		};
		expect(of('{"error":{"message":"","code":404,"status":"Not Found"}}')).toEqual(["request", ""]);
		expect(of("401 Unauthorized: invalid x-api-key")).toEqual(["access", ""]);
		expect(of("429 Too Many Requests")).toEqual(["service", ""]);
		expect(of('{"error":{"message":"Overloaded","code":529}}')).toEqual(["service", "retry"]);
		expect(of("TypeError: fetch failed")).toEqual(["connection", "retry"]);
		expect(of("something odd")).toEqual(["unknown", "retry"]);
		expect(classifyFailure("prompt is too long", { overflow: true })).toMatchObject({ category: "limit", actions: ["new_session"] });
	});

	it("keeps the provider's own words as details, not raw JSON", () => {
		expect(classifyFailure('{"error":{"message":"","code":404,"status":"Not Found"}}').details).toBe("Not Found");
		expect(classifyFailure('{"error":{"message":"model gemini-x is not available","code":400}}')).toMatchObject({
			title: "The model provider rejected the request (400)",
			details: "model gemini-x is not available",
		});
		expect(classifyFailure("x".repeat(5000)).details?.length).toBe(2000);
	});
});
