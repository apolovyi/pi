import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "../src/config.ts";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	let agentDir: string;
	beforeEach(() => {
		const scratch = join(getPackageDir(), ".tmp");
		mkdirSync(scratch, { recursive: true });
		agentDir = mkdtempSync(join(scratch, "summary-audit-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it.each(["x", "😀"])("audits bounded %s tool results without stdout or stderr output", (character) => {
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
				timestamp: Date.now(),
			},
		];

		const resultFile = join(agentDir, "serialized.txt");
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				join(getPackageDir(), "src", "experimental", "source-resolver.ts"),
				"--input-type=module",
				"--eval",
				`import { readFileSync, writeFileSync } from "node:fs";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
writeFileSync(process.argv[1], serializeConversation(JSON.parse(readFileSync(0, "utf8"))));`,
				resultFile,
			],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				input: JSON.stringify(messages),
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toBe("");
		expect(child.stderr).toBe("");
		const result = readFileSync(resultFile, "utf8");

		const directory = join(agentDir, "logs", "summary-truncation");
		const files = readdirSync(directory);
		expect(files).toHaveLength(1);
		const auditFile = join(directory, files[0]);
		const audit = JSON.parse(readFileSync(auditFile, "utf8"));
		expect(audit).toMatchObject({
			toolCallId: "tc1",
			toolName: "read",
			originalChars: longContent.length,
			offsetUnit: "utf16_code_units",
			originalText: longContent,
		});
		const [start, end] = audit.omittedRange;
		expect(audit.retainedChars).toBe(start + longContent.length - end);
		expect(audit.retainedChars).toBeLessThanOrEqual(2000);
		expect(result).toBe(
			`[Tool result name="read" call="tc1" isError=false]: ${longContent.slice(0, start)}\n\n[Truncated UTF-16 range [${start}, ${end}); audit: ${JSON.stringify(auditFile)}]\n\n${longContent.slice(end)}`,
		);
		expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
		if (process.platform !== "win32") {
			expect(statSync(auditFile).mode & 0o777).toBe(0o600);
		}
	});

	it("fails instead of silently truncating when the audit cannot be saved", () => {
		writeFileSync(join(agentDir, "logs"), "not a directory");
		expect(() =>
			serializeConversation([
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					timestamp: 1,
					content: [{ type: "text", text: "x".repeat(3000) }],
				},
			]),
		).toThrow();
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
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
		expect(readdirSync(agentDir)).toEqual([]);
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
