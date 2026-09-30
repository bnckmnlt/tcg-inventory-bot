import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { summarizeStates, resolveInventoryRows } from "./resolver.js";
import { sampleCatalog } from "../catalog/sample.js";

const path = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!path) {
  console.error("Usage: npm run inventory:import -- <path-to-xlsx>");
  process.exit(2);
}

const parsed = readV2InventoryWorkbook(path);
const resolved = resolveInventoryRows(sampleCatalog, parsed.rows);

console.log(JSON.stringify({
  workbook: path,
  parsedRows: parsed.rows.length,
  issues: parsed.issues,
  resolutionStates: summarizeStates(resolved),
  resolvedLots: resolved
    .filter((row) => row.state === "EXACT")
    .map((row) => ({
      sourceRow: parsed.rows.find((candidate) => candidate.inventoryId === row.inventoryId)?.sourceRow,
      inventoryId: row.inventoryId,
      skuId: row.sku?.skuId,
      remainingQty: row.remainingQty,
    })),
}, null, 2));
