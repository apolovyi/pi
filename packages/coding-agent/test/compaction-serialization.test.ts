import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("preserves tool-result boundaries and final verdicts within the same content budget", () => {
		const beginning = "command: pytest\n".padEnd(1000, "a");
		const ending = "\nFAIL: final regression verdict".padStart(1000, "z");
		const longContent = beginning + "x".repeat(3000) + ending;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain('[Tool result name="read" call="tc1" isError=false]:');
		expect(result).toBe(
			`[Tool result name="read" call="tc1" isError=false]: ${beginning}\n\n[... 3000 characters omitted from middle]\n\n${ending}`,
		);
		expect(result).not.toContain("x");
	});

	it.each([1500, 2000])("does not truncate a %i-character tool result", (length) => {
		const shortContent = "x".repeat(length);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result name="read" call="tc1" isError=false]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("retains bounded diagnostic and evidence lines from the omitted middle", () => {
		const evidence =
			"FAILED tests/payment.test.ts::reject_duplicate\nAssertionError: duplicate charge accepted\nFull output: /repo/.tmp/payment-verification.log";
		const result = serializeConversation([
			{
				role: "toolResult",
				toolName: "bash",
				toolCallId: "tc2",
				isError: true,
				timestamp: 1,
				content: [{ type: "text", text: `${"a".repeat(1500)}\n${evidence}\n${"z".repeat(1500)}` }],
			},
		]);
		expect(result).toContain('[Tool result name="bash" call="tc2" isError=true]:');
		expect(result).toContain("[Selected diagnostic/reference lines from omitted middle]:");
		expect(result).toContain(evidence);
	});

	it("keeps diagnostic excerpts bounded without slicing evidence paths", () => {
		const evidence = "Full output: /repo/.tmp/verifier.log";
		const result = serializeConversation([
			{
				role: "toolResult",
				toolName: "bash",
				toolCallId: "tc3",
				isError: true,
				timestamp: 1,
				content: [
					{
						type: "text",
						text: `${"a".repeat(1500)}\nERROR: ${"x".repeat(600)}\n${evidence}\n${Array.from({ length: 100 }, (_, index) => `FAILED test_${index}\n`).join("")}${"z".repeat(1500)}`,
					},
				],
			},
		]);
		const selected = result
			.split("[Selected diagnostic/reference lines from omitted middle]:\n")[1]
			?.split("\n\n")[0];
		expect(selected).toBeDefined();
		expect(selected!.length).toBeLessThanOrEqual(500);
		expect(selected).toContain(evidence);
		expect(selected).not.toContain("ERROR:");
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

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
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
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
