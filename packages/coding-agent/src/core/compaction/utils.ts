/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";

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

const TOOL_RESULT_MAX_CHARS = 2000;
const TOOL_DIAGNOSTIC_MAX_CHARS = 500;

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const headChars = Math.ceil(maxChars / 2);
	const tailChars = maxChars - headChars;
	const omittedChars = text.length - maxChars;
	const selectedLines: string[] = [];
	let selectedChars = 0;
	for (const line of text.slice(headChars, -tailChars).split("\n").slice(1, -1)) {
		if (
			!/^\s*(?:FAIL(?:ED)?\b|ERROR\b|AssertionError:|PASS(?:ED)?\b|\d+ (?:passed|failed)\b|Full output:|Evidence:)/i.test(
				line,
			)
		)
			continue;
		const addedChars = line.length + (selectedLines.length > 0 ? 1 : 0);
		if (selectedLines.includes(line) || selectedChars + addedChars > TOOL_DIAGNOSTIC_MAX_CHARS) continue;
		selectedLines.push(line);
		selectedChars += addedChars;
	}
	const diagnostics =
		selectedLines.length > 0
			? `\n\n[Selected diagnostic/reference lines from omitted middle]:\n${selectedLines.join("\n")}`
			: "";
	return `${text.slice(0, headChars)}\n\n[... ${omittedChars} characters omitted from middle]${diagnostics}\n\n${text.slice(-tailChars)}`;
}

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
			const content = contentText(msg.content, "");
			parts.push(
				`[Tool result name=${JSON.stringify(msg.toolName)} call=${JSON.stringify(msg.toolCallId)} isError=${msg.isError}]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`,
			);
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Preserve explicit negative facts unless later evidence or explicit user corrections supersede them. Distinguish known negatives (not run, not approved, not implemented) from unknown status. Do not weaken "not run" into "no result observed".

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
