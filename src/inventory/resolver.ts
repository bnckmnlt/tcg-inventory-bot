import type { Catalog, CardInput, MatchState } from "../catalog/types.js";
import { resolveCardInput } from "../catalog/resolver.js";
import { TCGdexRuntime } from "../catalog/runtime.js";
import type { InventoryResolution, ResolvedInventoryLot, V2InventoryRow } from "./types.js";

function toCardInput(row: V2InventoryRow): CardInput {
  return {
    name: row.cardName,
    setName: row.setSeries,
    cardNumber: row.cardNumber,
    language: row.language,
    variant: row.variantPrinting,
    condition: row.condition,
  };
}

/**
 * Resolve a V2-style inventory row to a catalog SKU before exposing its lot.
 * Inventory ID remains the lot identity; it is never used as card identity.
 */
export function resolveInventoryLot(catalog: Catalog, row: V2InventoryRow): ResolvedInventoryLot {
  const input = toCardInput(row);

  // V2 contains known placeholder card numbers (notably "1"). Treat these
  // as incomplete rather than accidentally resolving a real card #001.
  if (row.cardNumber.trim() === "1") {
    return {
      inventoryId: row.inventoryId,
      input,
      remainingQty: row.remainingQty,
      state: "INCOMPLETE",
      reasons: ["Card number is a known V2 placeholder and requires manual mapping."],
    };
  }

  const result = resolveCardInput(catalog, input);
  return {
    inventoryId: row.inventoryId,
    input,
    remainingQty: row.remainingQty,
    state: result.state,
    sku: result.sku,
    reasons: result.reasons,
  };
}

export function resolveInventoryLots(catalog: Catalog, rows: V2InventoryRow[], input: CardInput): InventoryResolution {
  const catalogResult = resolveCardInput(catalog, input);
  if (catalogResult.state !== "EXACT" || !catalogResult.sku) {
    return {
      state: catalogResult.state,
      input,
      lots: [],
      reasons: catalogResult.reasons,
    };
  }

  const lots = rows
    .map((row) => resolveInventoryLot(catalog, row))
    .filter((lot) => lot.state === "EXACT" && lot.sku?.skuId === catalogResult.sku?.skuId && lot.remainingQty > 0);

  const reasons: string[] = [];
  if (lots.length === 0) reasons.push("No available inventory lot matches the resolved SKU.");

  return {
    state: lots.length ? "EXACT" : "UNMATCHED",
    input,
    lots,
    reasons,
  };
}

export function resolveInventoryRows(catalog: Catalog, rows: V2InventoryRow[]): ResolvedInventoryLot[] {
  return rows.map((row) => resolveInventoryLot(catalog, row));
}

export async function resolveInventoryRowsRuntime(
  rows: V2InventoryRow[],
  runtime = new TCGdexRuntime(),
): Promise<ResolvedInventoryLot[]> {
  const resolved: ResolvedInventoryLot[] = [];

  for (const row of rows) {
    const input = toCardInput(row);
    const placeholder = row.cardNumber.trim() === "1";
    const lookupInput = placeholder ? { ...input, cardNumber: undefined } : input;
    const runtimeResult = await runtime.resolve(lookupInput);

    if (placeholder) {
      resolved.push({
        inventoryId: row.inventoryId,
        input,
        remainingQty: row.remainingQty,
        state: "INCOMPLETE",
        reasons: runtimeResult.candidates.length === 1
          ? ["Card number is a known V2 placeholder and requires manual mapping."]
          : [
              "Card number is a known V2 placeholder and requires manual mapping.",
              runtimeResult.candidates.length === 0
                ? "No TCGdex candidate matched the supplied set/name."
                : "Multiple TCGdex candidates matched the supplied set/name.",
            ],
      });
      continue;
    }

    const result = resolveCardInput(runtimeResult.catalog, input);
    resolved.push({
      inventoryId: row.inventoryId,
      input,
      remainingQty: row.remainingQty,
      state: result.state,
      sku: result.sku,
      reasons: result.reasons,
    });
  }

  return resolved;
}

export function summarizeStates(lots: ResolvedInventoryLot[]): Record<MatchState, number> {
  return lots.reduce<Record<MatchState, number>>(
    (counts, lot) => {
      counts[lot.state] += 1;
      return counts;
    },
    { EXACT: 0, AMBIGUOUS: 0, INCOMPLETE: 0, CONFLICT: 0, UNMATCHED: 0 },
  );
}
