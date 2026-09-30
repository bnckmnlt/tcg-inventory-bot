import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { summarizeStates, resolveInventoryRows, resolveInventoryRowsRuntime } from "./resolver.js";
import { readFileSync } from "node:fs";
import type { Catalog } from "../catalog/types.js";

const path = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!path) {
  console.error("Usage: npm run inventory:import -- <path-to-xlsx>");
  process.exit(2);
}

const parsed = readV2InventoryWorkbook(path);
const useLocalCatalog = process.argv.includes("--local-catalog");
const catalogPath = "data/catalog.json";
const resolved = useLocalCatalog
  ? resolveInventoryRows(JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog, parsed.rows)
  : await resolveInventoryRowsRuntime(parsed.rows);

console.log(JSON.stringify({
  workbook: path,
  catalog: useLocalCatalog ? catalogPath : "TCGdex runtime (on-demand)",
  parsedRows: parsed.rows.length,
  issues: parsed.issues,
  resolutionStates: summarizeStates(resolved),
  reviewQueue: resolved
    .filter((row) => row.state !== "EXACT")
    .map((row) => ({
      sourceRow: parsed.rows.find((candidate) => candidate.inventoryId === row.inventoryId)?.sourceRow,
      inventoryId: row.inventoryId,
      state: row.state,
      cardName: row.input.name,
      setSeries: row.input.setName,
      cardNumber: row.input.cardNumber,
      language: row.input.language,
      variant: row.input.variant,
      condition: row.input.condition,
      remainingQty: row.remainingQty,
      reasons: row.reasons,
    })),
  resolvedLots: resolved
    .filter((row) => row.state === "EXACT")
    .map((row) => ({
      sourceRow: parsed.rows.find((candidate) => candidate.inventoryId === row.inventoryId)?.sourceRow,
      inventoryId: row.inventoryId,
      skuId: row.sku?.skuId,
      remainingQty: row.remainingQty,
    })),
}, null, 2));
