import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type ServiceTier = ResponseCreateParamsStreaming["service_tier"];

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "Synthetic provenance model",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid/codex",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 4000000,
	maxTokens: 128000,
};

const payload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
).toString("base64url");
const token = `synthetic.${payload}.signature`;

function terminalEvent(responseServiceTier: ServiceTier, responseModel?: string): string {
	return `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "synthetic-response",
			model: responseModel,
			status: "completed",
			output: [],
			service_tier: responseServiceTier,
			usage: {
				input_tokens: 2000000,
				output_tokens: 1000000,
				total_tokens: 3000000,
				input_tokens_details: { cached_tokens: 1000000 },
			},
		},
	})}\n\n`;
}

describe("OpenAI Responses usage provenance", () => {
	afterEach(() => closeOpenAICodexWebSocketSessions());

	it.each([
		["priority", "default", "priority", 2],
		["priority", "fast", "fast", 2],
		["priority", "flex", "flex", 0.5],
		["priority", undefined, "priority", 2],
		[undefined, undefined, undefined, 1],
	] as const)(
		"keeps requested %s, reported %s and applied %s tiers distinct",
		async (requested, reported, applied, multiplier) => {
			const result = await stream(model, normalizeContext({ messages: [] }), {
				apiKey: token,
				transport: "sse",
				serviceTier: requested,
				fetch: async () =>
					new Response(terminalEvent(reported, "synthetic-model-snapshot"), {
						headers: { "content-type": "text/event-stream" },
					}),
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(result.model).toBe(model.id);
			expect(result.responseModel).toBe("synthetic-model-snapshot");
			expect(result.responseId).toBe("synthetic-response");
			expect(result.diagnostics).toContainEqual({
				type: "openai_responses_service_tier",
				timestamp: expect.any(Number),
				details: {
					pricingRequestServiceTier: requested ?? null,
					responseServiceTier: reported ?? null,
					appliedServiceTier: applied ?? null,
				},
			});
			expect(result.usage.cost).toEqual({
				input: multiplier,
				output: 2 * multiplier,
				cacheRead: 0.5 * multiplier,
				cacheWrite: 0,
				total: 3.5 * multiplier,
				totalFromProvider: false,
			});
		},
	);

	it("leaves an unreported response model absent", async () => {
		const result = await stream(model, normalizeContext({ messages: [] }), {
			apiKey: token,
			transport: "sse",
			fetch: async () =>
				new Response(terminalEvent(undefined), { headers: { "content-type": "text/event-stream" } }),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
	});
});
