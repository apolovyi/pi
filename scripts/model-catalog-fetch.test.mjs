import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCatalogFetch } from "./model-catalog-fetch.mjs";

const url = "https://catalog.example.test/models";

async function settle(context, promise) {
	const result = promise.then((value) => ({ value }), (error) => ({ error }));
	await setImmediate();
	context.mock.timers.tick(1000);
	await setImmediate();
	context.mock.timers.tick(2000);
	return result;
}

function mockBackoff(context) {
	context.mock.timers.enable({ apis: ["setTimeout"] });
	return context.mock.method(console, "warn", () => {});
}

for (const status of [408, 429, 500, 502, 503, 504]) {
	test(`retries HTTP ${status} and preserves the successful response`, async (context) => {
		const warnings = mockBackoff(context);
		const failed = new Response("temporary", { status });
		let calls = 0;
		const fetch = context.mock.fn(async () => ++calls === 1
			? failed
			: Response.json({ models: ["synthetic-model"] }, { status: 201, headers: { etag: "synthetic-etag" } }));
		const { value, error } = await settle(context, createCatalogFetch(fetch)(url));
		assert.equal(error, undefined);
		assert.deepEqual(await value.json(), { models: ["synthetic-model"] });
		assert.equal(value.status, 201);
		assert.equal(value.headers.get("etag"), "synthetic-etag");
		assert.equal(fetch.mock.callCount(), 2);
		assert.equal(failed.bodyUsed, true);
		assert.equal(warnings.mock.callCount(), 1);
	});
}

for (const status of [400, 401, 403, 404, 501]) {
	test(`does not retry permanent HTTP ${status}`, async (context) => {
		const fetch = context.mock.fn(async () => new Response("permanent", { status }));
		const response = await createCatalogFetch(fetch)(url);
		assert.equal(response.status, status);
		assert.equal(fetch.mock.callCount(), 1);
	});
}

test("retries a connection reset while consuming the response body", async (context) => {
	mockBackoff(context);
	const reset = new TypeError("terminated", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
	let calls = 0;
	const fetch = context.mock.fn(async () => ++calls === 1
		? new Response(new ReadableStream({ start(controller) { controller.error(reset); } }))
		: Response.json({ recovered: true }));
	const { value, error } = await settle(context, createCatalogFetch(fetch)(url));
	assert.equal(error, undefined);
	assert.deepEqual(await value.json(), { recovered: true });
	assert.equal(fetch.mock.callCount(), 2);
});

test("exhausts the bounded transport retry budget and keeps the original failure", async (context) => {
	const warnings = mockBackoff(context);
	const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
	const fetch = context.mock.fn(async () => { throw reset; });
	const { error } = await settle(context, createCatalogFetch(fetch)(url));
	assert.equal(error, reset);
	assert.equal(fetch.mock.callCount(), 3);
	assert.equal(warnings.mock.callCount(), 2);
});

test("returns the final unsuccessful HTTP response after exhausting retries", async (context) => {
	mockBackoff(context);
	const fetch = context.mock.fn(async () => new Response("unavailable", { status: 503 }));
	const { value, error } = await settle(context, createCatalogFetch(fetch)(url));
	assert.equal(error, undefined);
	assert.equal(value.status, 503);
	assert.equal(fetch.mock.callCount(), 3);
});

test("applies a fresh 30-second deadline to each attempt", async (context) => {
	mockBackoff(context);
	const timeout = new DOMException("deadline", "TimeoutError");
	const deadlines = context.mock.method(AbortSignal, "timeout", (milliseconds) => {
		assert.equal(milliseconds, 30_000);
		return AbortSignal.abort(timeout);
	});
	const fetch = context.mock.fn(async (_input, init) => { init.signal.throwIfAborted(); });
	const { error } = await settle(context, createCatalogFetch(fetch)(url));
	assert.equal(error, timeout);
	assert.equal(fetch.mock.callCount(), 3);
	assert.equal(deadlines.mock.callCount(), 3);
});

test("does not retry caller cancellation", async (context) => {
	const controller = new AbortController();
	const cancelled = new Error("synthetic cancellation");
	const fetch = context.mock.fn(async () => {
		controller.abort(cancelled);
		throw cancelled;
	});
	await assert.rejects(createCatalogFetch(fetch)(url, { signal: controller.signal }), (error) => error === cancelled);
	assert.equal(fetch.mock.callCount(), 1);
});

test("does not retry malformed JSON or certificate failures", async (context) => {
	const jsonFetch = context.mock.fn(async () => new Response("{invalid"));
	const response = await createCatalogFetch(jsonFetch)(url);
	await assert.rejects(response.json(), SyntaxError);
	assert.equal(jsonFetch.mock.callCount(), 1);
	const certificate = new TypeError("fetch failed", {
		cause: Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }),
	});
	const tlsFetch = context.mock.fn(async () => { throw certificate; });
	await assert.rejects(createCatalogFetch(tlsFetch)(url), (error) => error === certificate);
	assert.equal(tlsFetch.mock.callCount(), 1);
});

test("the discovery preload recovers from a real socket reset without changing native fetch elsewhere", () => {
	const fixture = `
		import assert from "node:assert/strict";
		import { createServer } from "node:http";
		let requests = 0;
		const server = createServer((request, response) => {
			if (++requests === 1) request.socket.destroy();
			else response.end(JSON.stringify({ recovered: true }));
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const response = await fetch("http://127.0.0.1:" + server.address().port);
			assert.deepEqual(await response.json(), { recovered: true });
			assert.equal(requests, 2);
		} finally {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		}
	`;
	const run = (args) => spawnSync(process.execPath, [...args, "--input-type=module", "--eval", fixture], {
		encoding: "utf8", timeout: 10_000,
	});
	const native = run([]);
	assert.equal(native.status, 1);
	assert.match(native.stderr, /fetch failed/);
	const recovered = run(["--import", fileURLToPath(new URL("./model-catalog-fetch.mjs", import.meta.url))]);
	assert.equal(recovered.status, 0, recovered.stderr);
	assert.match(recovered.stderr, /Retrying/);
});
