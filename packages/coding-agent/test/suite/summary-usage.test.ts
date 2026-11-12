import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageDir } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SummaryUsage } from "../../src/core/usage-totals.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function response(model: string, cost: number, diagnostics?: AssistantMessage["diagnostics"]): AssistantMessage {
	return {
		...fauxAssistantMessage("Synthetic summary"),
		api: "openai-codex-responses",
		provider: "summary-provider",
		model,
		responseModel: `${model}-snapshot`,
		responseId: `response-${model}`,
		timestamp: 1000,
		diagnostics,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 135,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	};
}

const historyResponse = response("history-model", 2, [
	{
		type: "openai_responses_service_tier",
		timestamp: 1001,
		details: { pricingRequestServiceTier: "fast", responseServiceTier: "default", appliedServiceTier: "fast" },
	},
]);
const prefixResponse = response("prefix-model", 3);

function expectedDetail(message: AssistantMessage): SummaryUsage {
	const { api, provider, model, responseModel, responseId, timestamp, stopReason, usage, diagnostics } = message;
	return { api, provider, model, responseModel, responseId, timestamp, stopReason, usage, diagnostics };
}

function seed(harness: Harness): string {
	const manager = harness.sessionManager;
	manager.appendMessage({ role: "user", content: "Earlier history", timestamp: 1 });
	const target = manager.appendMessage(fauxAssistantMessage("Earlier response"));
	manager.appendMessage({ role: "user", content: "Latest user request", timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("Latest assistant response"));
	harness.session.refreshContext();
	return target;
}

function streamResponses(harness: Harness, responses: AssistantMessage[]): () => number {
	let calls = 0;
	harness.session.agent.streamFunction = () => {
		const message = responses[calls++];
		if (!message) throw new Error("Unexpected summary call");
		const stream = createAssistantMessageEventStream();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: "stop", message });
		}
		return stream;
	};
	return () => calls;
}

describe("persisted summary usage provenance", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function harness(extensionFactories?: HarnessOptions["extensionFactories"]) {
		const scratch = join(getPackageDir(), ".tmp");
		mkdirSync(scratch, { recursive: true });
		const directory = mkdtempSync(join(scratch, "summary-usage-"));
		directories.push(directory);
		const created = await createHarness({
			sessionManager: SessionManager.create(directory, directory),
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
			extensionFactories,
		});
		harnesses.push(created);
		return created;
	}

	it.each(["manual", "automatic"])(
		"preserves both contributing responses for %s split compaction and reload",
		async (mode) => {
			const current = await harness();
			seed(current);
			const before = current.session.getSessionStats();
			const calls = streamResponses(current, [historyResponse, prefixResponse]);
			if (mode === "manual") {
				const result = await current.session.compact();
				expect(result).toHaveProperty("usageDetails", [
					expectedDetail(historyResponse),
					expectedDetail(prefixResponse),
				]);
			} else {
				await (
					current.session as unknown as {
						_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
					}
				)._runAutoCompaction("threshold", false);
			}
			expect(calls()).toBe(2);
			const entry = current.sessionManager.getLeafEntry();
			expect(entry).toMatchObject({
				type: "compaction",
				usage: { input: 200, output: 40, cacheRead: 20, cacheWrite: 10, totalTokens: 270, cost: { total: 5 } },
				usageDetails: [expectedDetail(historyResponse), expectedDetail(prefixResponse)],
			});
			const stats = current.session.getSessionStats();
			expect(stats.cost - before.cost).toBe(5);
			expect(stats.tokens.total - before.tokens.total).toBe(270);
			const reloaded = SessionManager.open(current.session.sessionFile!);
			expect(reloaded.getLeafEntry()).toEqual(JSON.parse(JSON.stringify(entry)));
			const resumed = await createHarness({ sessionManager: reloaded });
			harnesses.push(resumed);
			expect(resumed.session.getSessionStats().cost).toBe(stats.cost);
			expect(resumed.session.getSessionStats().tokens).toEqual(stats.tokens);
		},
	);

	it("preserves branch-summary identity, diagnostics and aggregate totals through reload", async () => {
		const current = await harness();
		const target = seed(current);
		const before = current.session.getSessionStats();
		streamResponses(current, [historyResponse]);
		const result = await current.session.navigateTree(target, { summarize: true });
		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			usage: historyResponse.usage,
			usageDetails: [expectedDetail(historyResponse)],
		});
		expect(current.session.getSessionStats().cost - before.cost).toBe(2);
		const reloaded = SessionManager.open(current.session.sessionFile!);
		expect(reloaded.getLeafEntry()).toEqual(JSON.parse(JSON.stringify(result.summaryEntry)));
	});

	it("records a single compaction call when the turn has no earlier history", async () => {
		const current = await harness();
		current.sessionManager.appendMessage({ role: "user", content: "Only user request", timestamp: 1 });
		current.sessionManager.appendMessage(fauxAssistantMessage("Only response"));
		current.session.refreshContext();
		const calls = streamResponses(current, [prefixResponse]);
		const result = await current.session.compact();
		expect(calls()).toBe(1);
		expect(result).toHaveProperty("usageDetails", [expectedDetail(prefixResponse)]);
		expect(result.usage).toEqual(prefixResponse.usage);
	});

	it.each([false, true])("does not invent provenance for extension compaction (supplied: %s)", async (supplied) => {
		const usageDetails = supplied ? [expectedDetail(historyResponse)] : undefined;
		const current = await harness([
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "Extension summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						usage: historyResponse.usage,
						usageDetails,
					},
				}));
			},
		]);
		seed(current);
		const result = await current.session.compact();
		expect(result.usageDetails).toEqual(usageDetails);
		expect(current.sessionManager.getLeafEntry()).toMatchObject({
			fromHook: true,
			usage: historyResponse.usage,
			usageDetails,
		});
	});

	it.each([false, true])("preserves only extension-supplied branch provenance (supplied: %s)", async (supplied) => {
		const usageDetails = supplied ? [expectedDetail(prefixResponse)] : undefined;
		const current = await harness([
			(pi) => {
				pi.on("session_before_tree", () => ({
					summary: { summary: "Extension branch", usage: prefixResponse.usage, usageDetails },
				}));
			},
		]);
		const target = seed(current);
		const result = await current.session.navigateTree(target, { summarize: true });
		expect(result.summaryEntry).toMatchObject({ fromHook: true, usage: prefixResponse.usage, usageDetails });
	});

	it("preserves extension provenance on boundary compaction drafts", async () => {
		const current = await harness([
			(pi) => {
				pi.on("turn_end", () => ({
					entries: [
						{
							type: "compaction",
							summary: "Boundary checkpoint",
							firstKeptEntryId: null,
							usage: prefixResponse.usage,
							usageDetails: [expectedDetail(prefixResponse)],
						},
					],
				}));
			},
		]);
		current.setResponses([fauxAssistantMessage("Normal response")]);
		await current.session.prompt("Synthetic request");
		expect(current.sessionManager.getLeafEntry()).toMatchObject({
			type: "compaction",
			usage: prefixResponse.usage,
			usageDetails: [expectedDetail(prefixResponse)],
		});
	});

	it("loads legacy summary usage without repricing or invented provenance", async () => {
		const current = await harness();
		const target = seed(current);
		current.sessionManager.appendCompaction(
			"Legacy checkpoint",
			target,
			100,
			undefined,
			false,
			historyResponse.usage,
		);
		current.sessionManager.branchWithSummary(target, "Legacy branch", undefined, true, prefixResponse.usage);
		const before = current.session.getSessionStats();
		const reloaded = SessionManager.open(current.session.sessionFile!);
		const summaries = reloaded
			.getEntries()
			.filter((entry) => entry.type === "compaction" || entry.type === "branch_summary");
		expect(summaries.map((entry) => entry.usageDetails)).toEqual([undefined, undefined]);
		expect(summaries.map((entry) => entry.usage?.cost.total)).toEqual([2, 3]);
		const resumed = await createHarness({ sessionManager: reloaded });
		harnesses.push(resumed);
		expect(resumed.session.getSessionStats().cost).toBe(before.cost);
		expect(resumed.session.getSessionStats().tokens).toEqual(before.tokens);
	});

	it("preserves provenance for a non-split history summary", async () => {
		const current = await harness();
		seed(current);
		current.sessionManager.appendMessage({ role: "user", content: "Kept request", timestamp: 3 });
		current.session.refreshContext();
		const calls = streamResponses(current, [historyResponse]);
		const result = await current.session.compact();
		expect(calls()).toBe(1);
		expect(result.usageDetails).toEqual([expectedDetail(historyResponse)]);
		expect(result.usage).toEqual(historyResponse.usage);
	});

	it("keeps existing retry accounting and records only the successful contributing responses", async () => {
		const current = await harness();
		seed(current);
		current.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		const calls = streamResponses(current, [
			{ ...prefixResponse, stopReason: "error", errorMessage: "terminated" },
			historyResponse,
			prefixResponse,
		]);
		const result = await current.session.compact();
		expect(calls()).toBe(3);
		expect(result.usage?.cost.total).toBe(5);
		expect(result.usageDetails).toEqual([expectedDetail(historyResponse), expectedDetail(prefixResponse)]);
	});

	it.each(["error", "aborted", "length"] as const)(
		"does not persist a failed %s branch summary",
		async (stopReason) => {
			const current = await harness();
			const target = seed(current);
			const before = current.session.getSessionStats();
			streamResponses(current, [{ ...prefixResponse, stopReason, errorMessage: "Synthetic failure" }]);
			if (stopReason === "aborted") {
				expect(await current.session.navigateTree(target, { summarize: true })).toMatchObject({
					cancelled: true,
					aborted: true,
				});
			} else {
				await expect(current.session.navigateTree(target, { summarize: true })).rejects.toThrow();
			}
			expect(current.sessionManager.getEntries().filter((entry) => entry.type === "branch_summary")).toEqual([]);
			expect(current.session.getSessionStats().cost).toBe(before.cost);
		},
	);

	it.each(["error", "aborted", "length"] as const)(
		"does not persist a failed %s compaction or its partial usage",
		async (stopReason) => {
			const current = await harness();
			seed(current);
			const before = current.session.getSessionStats();
			streamResponses(current, [
				historyResponse,
				{ ...prefixResponse, stopReason, errorMessage: "Synthetic failure" },
			]);
			if (stopReason === "aborted") {
				current.session.agent.streamFunction = () => {
					current.session.abortCompaction();
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "error", reason: "aborted", error: { ...prefixResponse, stopReason } });
					return stream;
				};
			}
			await expect(current.session.compact()).rejects.toThrow();
			expect(current.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(current.session.getSessionStats().cost).toBe(before.cost);
		},
	);
});
