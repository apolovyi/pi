import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.signature`;
const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "Synthetic Sol fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] });
const handshakes: Record<string, string>[] = [];
const handshakeUrls: string[] = [];
const bodies: Record<string, unknown>[] = [];

function responseEvents() {
	return [
		{ type: "response.created", response: { id: "synthetic-response" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "OK" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "synthetic-response",
				status: "completed",
				service_tier: "default",
				usage: { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 },
			},
		},
	];
}

class SyntheticWebSocket {
	readyState = 1;
	private listeners = new Map<string, Set<(event: unknown) => void>>();
	constructor(url: string, options: { headers: Record<string, string> }) {
		handshakeUrls.push(url);
		handshakes.push(options.headers);
		queueMicrotask(() => this.dispatch("open", {}));
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		const handlers = this.listeners.get(type) ?? new Set();
		handlers.add(listener);
		this.listeners.set(type, handlers);
	}
	removeEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	send(data: string) {
		bodies.push(JSON.parse(data) as Record<string, unknown>);
		queueMicrotask(() => {
			for (const event of responseEvents()) this.dispatch("message", { data: JSON.stringify(event) });
		});
	}
	close() {
		this.readyState = 3;
	}
	private dispatch(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

beforeEach(() => {
	handshakes.length = 0;
	handshakeUrls.length = 0;
	bodies.length = 0;
	vi.stubGlobal("WebSocket", SyntheticWebSocket);
});
afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

describe("Codex client policy", () => {
	it.each(["default", "priority", undefined] as const)(
		"routes and estimates the final %s payload when the response reports default",
		async (tier) => {
			for (const transport of ["sse", "websocket"] as const) {
				let sseHeaders: Headers | undefined;
				const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
					sseHeaders = new Headers(init?.headers);
					const body =
						typeof init?.body === "string"
							? init.body
							: zstdDecompressSync(init?.body as Uint8Array).toString("utf8");
					bodies.push(JSON.parse(body) as Record<string, unknown>);
					return new Response(
						responseEvents()
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				});
				const result = await stream(model, context, {
					apiKey: token,
					transport,
					fetch,
					serviceTier: tier === "default" ? "priority" : "default",
					sessionId: "synthetic-session",
					onPayload: (body) => ({ ...(body as object), service_tier: tier }),
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "OK" }));
				expect(bodies.at(-1)?.service_tier).toBe(tier);
				expect(bodies.at(-1)?.client_metadata).toEqual({
					session_id: "synthetic-session",
					thread_id: "synthetic-session",
				});
				const headers = transport === "sse" ? sseHeaders : new Headers(handshakes.at(-1));
				expect(headers?.get("originator")).toBe("codex_cli_rs");
				expect(headers?.get("version")).toBe("0.167.0");
				expect(headers?.get("thread-id")).toBe("synthetic-session");
				expect(headers?.get("user-agent")).toMatch(/^codex_cli_rs\/0\.167\.0 /);
				expect(headers?.get("x-codex-routing-hint")).toBe(`model=gpt-6.1-sol${tier ? `;tier=${tier}` : ""}`);
				expect(result.usage.cost.input).toBe(tier === "priority" ? 2 : 1);
				expect(result.usage.cost.output).toBe(tier === "priority" ? 4 : 2);
				expect(result.usage.cost.total).toBe(tier === "priority" ? 6 : 3);
			}
		},
	);

	it("does not reuse a handshake across tier, model, caller headers, or endpoint changes", async () => {
		const options = {
			apiKey: token,
			sessionId: "synthetic-session",
			transport: "auto" as const,
			serviceTier: "default" as const,
		};
		await stream(model, context, options).result();
		await stream(model, context, options).result();
		expect(handshakes).toHaveLength(1);
		const priority = { ...options, serviceTier: "priority" as const };
		await stream(model, context, priority).result();
		expect(handshakes).toHaveLength(2);
		const otherModel = { ...model, id: "gpt-6-astra" };
		await stream(otherModel, context, priority).result();
		expect(handshakes).toHaveLength(3);
		const caller = {
			...priority,
			headers: { originator: "synthetic-client", "user-agent": "synthetic-client/1" },
		};
		await stream(otherModel, context, caller).result();
		expect(handshakes).toHaveLength(4);
		const capability = { ...caller, headers: { ...caller.headers, "x-codex-client-info": "synthetic-capability" } };
		await stream(otherModel, context, capability).result();
		expect(handshakes).toHaveLength(5);
		await stream(
			{ ...otherModel, baseUrl: "https://synthetic-codex.test/backend-api" },
			context,
			capability,
		).result();
		expect(handshakes).toHaveLength(6);
		expect(handshakeUrls.at(-1)).toBe("wss://synthetic-codex.test/backend-api/codex/responses");
	});

	it.each([null, "model=synthetic-route;tier=priority"])(
		"honors explicit caller routing headers %j",
		async (routing) => {
			const result = await stream(model, context, {
				apiKey: token,
				transport: "websocket",
				serviceTier: "priority",
				headers: { "x-codex-routing-hint": routing },
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(handshakes.at(-1)?.["x-codex-routing-hint"] ?? null).toBe(routing);
		},
	);
});
