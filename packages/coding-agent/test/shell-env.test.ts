import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBinDir } from "../src/config.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { getShellEnv } from "../src/utils/shell.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-shell-env-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
	for (const key of Object.keys(process.env)) {
		if (key.toLowerCase() === "path") vi.stubEnv(key, undefined);
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("shell environment PATH authority", () => {
	it.each(["PATH", "Path"])("appends fallback tools without changing inherited %s precedence", (key) => {
		const inheritedPath = [join(directory, "managed"), join(directory, "system")].join(delimiter);
		vi.stubEnv(key, inheritedPath);

		const env = getShellEnv();

		expect(env[key]).toBe(`${inheritedPath}${delimiter}${getBinDir()}`);
		expect(process.env[key]).toBe(inheritedPath);
		expect(Object.keys(env).filter((name) => name.toLowerCase() === "path")).toEqual([key]);
	});

	it.each([0, 1, 2])("preserves an existing tools directory at position %i without duplication", (position) => {
		const entries = [join(directory, "managed"), join(directory, "system")];
		entries.splice(position, 0, getBinDir());
		const inheritedPath = entries.join(delimiter);
		vi.stubEnv("PATH", inheritedPath);

		expect(getShellEnv().PATH).toBe(inheritedPath);
	});

	it.each([undefined, ""])("makes fallback tools available with PATH=%s", (path) => {
		vi.stubEnv("PATH", path);

		expect(getShellEnv().PATH).toBe(getBinDir());
		expect(process.env.PATH).toBe(path);
	});

	it.skipIf(process.platform === "win32")(
		"executes inherited commands ahead of colliding tools and retains fd/rg fallbacks",
		async () => {
			const managedBin = join(directory, "managed");
			mkdirSync(managedBin);
			mkdirSync(getBinDir(), { recursive: true });
			for (const name of ["node", "codex"]) {
				writeFileSync(join(managedBin, name), `#!/bin/sh\nprintf '%s\\n' 'synthetic-managed-${name}'\n`, {
					mode: 0o755,
				});
			}
			for (const name of ["node", "codex", "fd", "rg"]) {
				writeFileSync(join(getBinDir(), name), `#!/bin/sh\nprintf '%s\\n' 'synthetic-fallback-${name}'\n`, {
					mode: 0o755,
				});
			}
			vi.stubEnv("PATH", managedBin);
			const tool = createBashTool(directory);

			const result = await tool.execute("path-authority", { command: "node; codex; fd; rg" });
			const output = result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");

			expect(output.trim()).toBe(
				[
					"synthetic-managed-node",
					"synthetic-managed-codex",
					"synthetic-fallback-fd",
					"synthetic-fallback-rg",
				].join("\n"),
			);
		},
	);
});
