import { readFile, writeFile } from "node:fs/promises";
import type { Catalog, CardInput, ResolveResult } from "./types.js";
import { resolveCardInput } from "./resolver.js";
import { TCGdexRuntime, type RuntimeCandidate } from "./runtime.js";

export type EnrichmentState = "ENRICHED" | "AMBIGUOUS" | "NOT_FOUND" | "ERROR" | "LOCAL";

export interface EnrichmentResult {
  state: EnrichmentState;
  input: CardInput;
  local: ResolveResult;
  externalCandidates: RuntimeCandidate[];
  resolved?: ResolveResult;
  catalog?: Catalog;
  reason?: string;
}

function mergeById<T>(base: T[], additions: T[], getId: (item: T) => string): T[] {
  const result = [...base];
  const seen = new Set(base.map(getId));
  for (const item of additions) {
    const id = getId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function mergeCatalog(base: Catalog, addition: Catalog): Catalog {
  return {
    sets: mergeById(base.sets, addition.sets, (item) => item.setId),
    cards: mergeById(base.cards, addition.cards, (item) => item.catalogCardId),
    printings: mergeById(base.printings, addition.printings, (item) => item.printingId),
    variants: mergeById(base.variants, addition.variants, (item) => item.variantId),
    skus: mergeById(base.skus, addition.skus, (item) => item.skuId),
    externalIdMappings: mergeById(base.externalIdMappings, addition.externalIdMappings, (item) => item.externalIdMapId),
  };
}

export async function enrichCardInput(
  catalog: Catalog,
  input: CardInput,
  runtime: TCGdexRuntime = new TCGdexRuntime(),
): Promise<EnrichmentResult> {
  const local = resolveCardInput(catalog, input, { allowMissingCardNumber: true });
  if (local.state === "EXACT") {
    return { state: "LOCAL", input, local, externalCandidates: [], resolved: local, catalog };
  }

  if (local.state !== "UNMATCHED") {
    return { state: local.state === "AMBIGUOUS" ? "AMBIGUOUS" : "LOCAL", input, local, externalCandidates: [], reason: local.reasons.join(" ") };
  }

  try {
    const runtimeResult = await runtime.resolve(input);
    if (runtimeResult.candidates.length === 0) {
      return { state: "NOT_FOUND", input, local, externalCandidates: [], reason: "External catalog returned no matching candidates." };
    }
    if (runtimeResult.candidates.length !== 1) {
      return {
        state: "AMBIGUOUS",
        input,
        local,
        externalCandidates: runtimeResult.candidates,
        reason: "External catalog returned multiple candidates; nothing was persisted.",
      };
    }

    const enrichedCatalog = mergeCatalog(catalog, runtimeResult.catalog);
    const resolved = resolveCardInput(enrichedCatalog, input, { allowMissingCardNumber: true });
    if (resolved.state !== "EXACT" || !resolved.sku) {
      return {
        state: resolved.state === "AMBIGUOUS" ? "AMBIGUOUS" : "NOT_FOUND",
        input,
        local,
        externalCandidates: runtimeResult.candidates,
        resolved,
        catalog: enrichedCatalog,
        reason: resolved.reasons.join(" "),
      };
    }

    return {
      state: "ENRICHED",
      input,
      local,
      externalCandidates: runtimeResult.candidates,
      resolved,
      catalog: enrichedCatalog,
    };
  } catch (error) {
    return {
      state: "ERROR",
      input,
      local,
      externalCandidates: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enrichCatalogFile(
  catalogPath: string,
  input: CardInput,
  runtime: TCGdexRuntime = new TCGdexRuntime(),
): Promise<EnrichmentResult> {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
  const result = await enrichCardInput(catalog, input, runtime);
  if (result.state === "ENRICHED" && result.catalog) {
    await writeFile(catalogPath, JSON.stringify(result.catalog, null, 2) + "\n", "utf8");
  }
  return result;
}
