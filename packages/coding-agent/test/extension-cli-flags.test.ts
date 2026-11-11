import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const packageRoot = getPackageDir();
const sourceRoot = join(packageRoot, "src");
const cliPath = join(sourceRoot, "cli.ts");
const sourceResolverPath = join(sourceRoot, "experimental", "source-resolver.ts");
const scratchDir = join(packageRoot, ".tmp");

const extensionSource = `export default function (pi) {
  pi.registerFlag("fast", { type: "boolean", default: false });
  pi.registerFlag("preset", { type: "string", default: "regular" });
  pi.registerProvider("flag-test", {
    api: "openai-completions",
    apiKey: "synthetic-test-key",
    baseUrl: "https://example.invalid",
    models: [{ id: "model", name: "Synthetic flag test", reasoning: false,
      input: ["text"], contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  pi.on("input", (event) => {
    console.error(JSON.stringify({ fast: pi.getFlag("fast"), preset: pi.getFlag("preset"), text: event.text }));
    return { action: "handled" };
  });
}`;

describe("extension flags through the CLI", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let extensionPath: string;

	beforeEach(() => {
		mkdirSync(scratchDir, { recursive: true });
		root = mkdtempSync(join(scratchDir, "extension-cli-flags-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		extensionPath = join(root, "flags.ts");
		mkdirSync(agentDir);
		mkdirSync(projectDir);
		writeFileSync(extensionPath, extensionSource);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function runCli(args: string[]) {
		return spawnSync(
			process.execPath,
			[
				"--import",
				sourceResolverPath,
				cliPath,
				"--offline",
				"--no-session",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-themes",
				"--extension",
				extensionPath,
				"--model",
				"flag-test/model",
				"--print",
				...args,
			],
			{
				cwd: projectDir,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
				timeout: 10000,
			},
		);
	}

	it.each([
		{ args: ["explain this"], fast: false },
		{ args: ["--fast", "explain this"], fast: true },
		{ args: ["--fast=true", "explain this"], fast: true },
		{ args: ["--fast=false", "explain this"], fast: false },
		{ args: ["--fast", "--fast=false", "explain this"], fast: false },
	])("delivers the prompt and correct boolean for $args", ({ args, fast }) => {
		const result = runCli(args);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain(JSON.stringify({ fast, preset: "regular", text: "explain this" }));
	});

	it("preserves mixed string and boolean options and prompt ordering", () => {
		const result = runCli(["before", "--preset", "review", "--fast", "after"]);
		expect(result.status, result.stderr).toBe(0);
		expect(
			result.stderr
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{ fast: true, preset: "review", text: "before" },
			{ fast: true, preset: "review", text: "after" },
		]);
	});

	it.each([
		["--fast=off", "Invalid value for --fast"],
		["--preset", "Extension flag --preset requires a value"],
		["--unknown", "Unknown option --unknown"],
	])("rejects %s before processing a prompt", (arg, error) => {
		const result = runCli(["explain this", arg]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`Error: ${error}`);
		expect(result.stderr).not.toContain('"text":"explain this"');
	});
});
