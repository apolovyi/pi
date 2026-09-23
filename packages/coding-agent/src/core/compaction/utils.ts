/**
 * Shared utilities for compaction and branch summarization.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`call=${JSON.stringify(block.id)} ${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			let content = contentText(msg.content, "");
			if (content.length > 2000) {
				const head = content.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, "");
				const tail = content.slice(-1000).replace(/^[\uDC00-\uDFFF]/, "");
				const directory = join(getAgentDir(), "logs", "summary-truncation");
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				const auditFile = join(directory, `${randomUUID()}.json`);
				const record = {
					type: "summary_tool_result_truncation",
					timestamp: new Date().toISOString(),
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					messageTimestamp: msg.timestamp,
					originalChars: content.length,
					retainedChars: head.length + tail.length,
					omittedRange: [head.length, content.length - tail.length],
					offsetUnit: "utf16_code_units",
				};
				writeFileSync(auditFile, JSON.stringify({ ...record, originalText: content }), { mode: 0o600, flag: "wx" });
				content = `${head}\n\n[Truncated UTF-16 range [${record.omittedRange.join(", ")}); audit: ${JSON.stringify(auditFile)}]\n\n${tail}`;
			}
			parts.push(
				`[Tool result name=${JSON.stringify(msg.toolName)} call=${JSON.stringify(msg.toolCallId)} isError=${msg.isError}]: ${content}`,
			);
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Preserve explicit user corrections and current constraints; later corrections supersede earlier conflicting instructions. Distinguish approved decisions from proposals, verified outcomes from unverified claims, and known negatives (not run, not approved, not implemented) from unknown status.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
