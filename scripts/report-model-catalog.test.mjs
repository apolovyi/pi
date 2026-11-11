import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareModelCatalogs, formatModelCatalogReport } from "./report-model-catalog.mjs";

const model = {
	type: "chat",
	id: "synthetic-model",
	provider: "synthetic-provider",
	api: "openai-completions",
	reasoning: true,
	contextWindow: 1000,
	cost: { input: 1, output: 2 },
};
const catalog = (...models) => ({ "synthetic-provider": models });

test("reports model additions and removals without treating them as compatibility failures", () => {
	assert.deepEqual(compareModelCatalogs(catalog(model), catalog({ ...model, id: "new-model" })), {
		added: ["synthetic-provider/chat/new-model"],
		removed: ["synthetic-provider/chat/synthetic-model"],
		changed: [],
	});
});

test("reports API, capability, and nested metadata changes with before and after evidence", () => {
	const updated = { ...model, api: "anthropic-messages", reasoning: false, cost: { input: 2, output: 2 } };
	assert.deepEqual(compareModelCatalogs(catalog(model), catalog(updated)), {
		added: [],
		removed: [],
		changed: [{
			id: "synthetic-provider/chat/synthetic-model",
			fields: ["api", "cost", "reasoning"],
			before: model,
			after: updated,
		}],
	});
});

test("ignores property and model ordering without ignoring content changes", () => {
	const second = { ...model, id: "second-model" };
	const reordered = { cost: { output: 2, input: 1 }, contextWindow: 1000, reasoning: true,
		api: "openai-completions", provider: "synthetic-provider", id: "synthetic-model", type: "chat" };
	assert.deepEqual(compareModelCatalogs(catalog(model, second), catalog(second, reordered)), {
		added: [], removed: [], changed: [],
	});
});

test("keeps model type and provider identities separate", () => {
	const current = { ...catalog(model, { ...model, type: "image" }), other: [{ ...model, provider: "other" }] };
	assert.deepEqual(compareModelCatalogs(catalog(model), current).added, [
		"other/chat/synthetic-model", "synthetic-provider/image/synthetic-model",
	]);
});

test("escapes untrusted model names in the Markdown summary", () => {
	const markdown = formatModelCatalogReport({
		checkedAt: "synthetic-time", baselineRevision: "synthetic-baseline", currentRevision: "synthetic-current",
		added: ["<script>\n# fake [link](https://example.test) `code`"], removed: [], changed: [],
	});
	assert.ok(markdown.includes("\\<script\\>"));
	assert.ok(markdown.includes("\\# fake \\[link\\]\\(https://example.test\\) \\`code\\`"));
	assert.ok(!markdown.includes("\n# fake"));
	assert.ok(markdown.includes("not the previous run"));
});

test("writes raw evidence and the CI summary, and fails clearly on invalid input", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-catalog-report-"));
	try {
		const baseline = join(root, "baseline.json");
		const current = join(root, "current.json");
		const summary = join(root, "summary.md");
		const output = join(root, "report");
		writeFileSync(baseline, JSON.stringify(catalog(model)));
		writeFileSync(current, JSON.stringify(catalog({ ...model, reasoning: false })));
		const run = () => spawnSync(process.execPath, ["scripts/report-model-catalog.mjs", baseline, current, output], {
			encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
		});
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
		assert.match(report.currentRevision, /^sha256-[a-f0-9]{64}$/);
		assert.notEqual(report.currentRevision, report.baselineRevision);
		assert.deepEqual(report.changed[0].fields, ["reasoning"]);
		assert.equal(readFileSync(summary, "utf8"), readFileSync(join(output, "report.md"), "utf8"));
		writeFileSync(current, "invalid-json");
		const invalid = run();
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /^\[model-catalog\]/);
		assert.ok(!invalid.stderr.includes("\n    at "));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
