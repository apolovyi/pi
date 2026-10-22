import { describe, expect, it } from "vitest";
import { defaultModelPerProvider } from "../../coding-agent/src/core/model-resolver.ts";
import { builtinModels, getAllBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { AnyModel } from "../src/types.ts";
import { getModelType } from "../src/utils/model-operations.ts";

const models = builtinModels();

function modelEntries(entries: readonly AnyModel[]): Map<string, AnyModel> {
	return new Map(entries.map((model) => [`${getModelType(model)}:${model.id}`, model]));
}

describe("current catalog provider compatibility", () => {
	it.each(getBuiltinProviders())("exposes every %s catalog entry through its runtime provider", (providerId) => {
		const provider = models.getProvider(providerId);
		expect(provider, `Missing runtime provider: ${providerId}`).toBeDefined();
		const catalog = getAllBuiltinModels(providerId);
		expect(catalog.length).toBeGreaterThan(0);
		expect(modelEntries(models.getAllModels(providerId))).toEqual(modelEntries(catalog));
		for (const model of catalog) {
			expect(model.provider).toBe(providerId);
			if (getModelType(model) === "image") expect(provider?.generateImages).toBeTypeOf("function");
			else if (getModelType(model) === "classifier") expect(provider?.classify).toBeTypeOf("function");
		}
	});
});

describe("current catalog runtime defaults", () => {
	it.each(Object.entries(defaultModelPerProvider))("retains the selected default %s/%s", (providerId, modelId) => {
		expect(
			models.getModel(providerId, modelId),
			`Runtime default ${providerId}/${modelId} is absent from the current catalog. Review model-resolver.ts; do not silently substitute another model.`,
		).toBeDefined();
	});
});
