import timers from "node:timers/promises";

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const retryableCodes = new Set([
	"ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export function createCatalogFetch(fetch) {
	return async (input, init) => {
		const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		for (let attempt = 1; ; attempt++) {
			callerSignal?.throwIfAborted();
			const deadline = AbortSignal.timeout(30_000);
			const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
			let failure;
			try {
				const response = await fetch(input, { ...init, signal });
				if (!response.ok) {
					if (!retryableStatuses.has(response.status) || attempt === 3) return response;
					await response.body?.cancel();
					failure = `HTTP ${response.status}`;
				} else {
					const body = response.body === null ? null : await response.arrayBuffer();
					return new Response(body, response);
				}
			} catch (error) {
				const code = error?.cause?.code ?? error?.code;
				if (callerSignal?.aborted || attempt === 3 || (!deadline.aborted && !retryableCodes.has(code))) {
					throw error;
				}
				failure = error.message;
			}
			console.warn(`[model-catalog] ${String(input)} failed (${failure}). Retrying in ${attempt}s (${attempt}/2).`);
			await timers.setTimeout(attempt * 1000, undefined, { signal: callerSignal });
		}
	};
}

globalThis.fetch = createCatalogFetch(globalThis.fetch);
