import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it.each(["x", "😀"])("preserves both ends of bounded %s results", (character) => {
		const beginning = "command: pytest\n".padEnd(999, "a");
		const ending = "\nFAIL: final regression verdict".padStart(999, "z");
		const longContent = beginning + character.repeat(3000) + ending;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: 1,
			},
		];
		const result = serializeConversation(messages);
		const retainedBoundary = character === "x" ? 1000 : 999;
		expect(result).toBe(
			`[Tool result name="read" call="tc1" isError=false]: ${longContent.slice(0, retainedBoundary)}\n\n[... ${longContent.length - retainedBoundary * 2} characters omitted]\n\n${longContent.slice(-retainedBoundary)}`,
		);
		expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
		expect(serializeConversation(messages)).toBe(result);
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: 1,
			},
		];
		expect(serializeConversation(messages)).toBe(
			`[Tool result name="read" call="tc1" isError=false]: ${shortContent}`,
		);
	});

	it("retains an empty tool failure instead of dropping it", () => {
		const result = serializeConversation([
			{
				role: "toolResult",
				toolName: "bash",
				toolCallId: "tc4",
				isError: true,
				timestamp: 1,
				content: [],
			},
		]);
		expect(result).toBe('[Tool result name="bash" call="tc4" isError=true]: ');
	});

	it("does not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: longText }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		];
		expect(serializeConversation(messages)).toBe(`[User]: ${longText}\n\n[Assistant]: ${longText}`);
	});
});
