import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

function indexCatalog(catalog) {
	return new Map(Object.entries(catalog).flatMap(([provider, models]) =>
		models.map((model) => [`${provider}/${model.type}/${model.id}`, model]),
	));
}

export function compareModelCatalogs(baseline, current) {
	const before = indexCatalog(baseline);
	const after = indexCatalog(current);
	const added = [];
	const removed = [];
	const changed = [];
	for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const previous = before.get(id);
		const next = after.get(id);
		if (!previous) added.push(id);
		else if (!next) removed.push(id);
		else if (!isDeepStrictEqual(previous, next)) {
			const fields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
				.filter((field) => !isDeepStrictEqual(previous[field], next[field]))
				.sort();
			changed.push({ id, fields, before: previous, after: next });
		}
	}
	return { added, removed, changed };
}

function markdownLabel(value) {
	return JSON.stringify(value).slice(1, -1).replace(/[\\`*_{}\[\]<>()!|#]/g, "\\$&");
}

export function formatModelCatalogReport(report) {
	const lines = [
		"# Current model catalog",
		"",
		`Checked at ${report.checkedAt}. Compared with the bundled release fixture, not the previous run.`,
		`Baseline: ${report.baselineRevision}. Current: ${report.currentRevision}.`,
		"",
		`${report.added.length} added, ${report.removed.length} removed, ${report.changed.length} changed.`,
	];
	for (const [label, entries] of [
		["Added", report.added],
		["Removed", report.removed],
		["Changed", report.changed.map(({ id, fields }) => `${id}: ${fields.join(", ")}`)],
	]) {
		lines.push("", `## ${label}`, "", ...entries.map((entry) => `- ${markdownLabel(entry)}`));
		if (entries.length === 0) lines.push("None.");
	}
	lines.push("", "Catalog membership is not proof of account access or successful inference.", "");
	return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = process.argv.slice(2);
		if (args.length !== 3) {
			throw new Error("Usage: node scripts/report-model-catalog.mjs <baseline.json> <current.json> <report-directory>");
		}
		const [baselinePath, currentPath, outputDirectory] = args;
		const baseline = readFileSync(baselinePath);
		const current = readFileSync(currentPath);
		const report = {
			checkedAt: new Date().toISOString(),
			baselineRevision: `sha256-${createHash("sha256").update(baseline).digest("hex")}`,
			currentRevision: `sha256-${createHash("sha256").update(current).digest("hex")}`,
			...compareModelCatalogs(JSON.parse(baseline.toString("utf8")), JSON.parse(current.toString("utf8"))),
		};
		const markdown = formatModelCatalogReport(report);
		mkdirSync(outputDirectory, { recursive: true });
		writeFileSync(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		writeFileSync(join(outputDirectory, "report.md"), markdown);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
		console.log(`${report.added.length} added, ${report.removed.length} removed, ${report.changed.length} changed; report: ${outputDirectory}`);
	} catch (error) {
		console.error(`[model-catalog] ${error instanceof Error ? error.message : String(error)}. Inspect the input catalogs and rerun the report command.`);
		process.exitCode = 1;
	}
}
