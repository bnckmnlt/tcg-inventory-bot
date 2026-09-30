import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { resolveCardInput } from "../catalog/resolver.js";
import { resolveInventoryRows } from "./resolver.js";
import { TCGdexRuntime } from "../catalog/runtime.js";
import type { CardInput } from "../catalog/types.js";

function isPlaceholderNumber(value: string | undefined): boolean {
  return (value ?? "").trim() === "1";
}

const path = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!path) {
  console.error("Usage: npm run inventory:review:runtime -- <path-to-v2-xlsx>");
  process.exit(2);
}

const workbook = readV2InventoryWorkbook(path);
const runtime = new TCGdexRuntime();
const localRows = resolveInventoryRows({ sets: [], cards: [], printings: [], variants: [], skus: [], externalIdMappings: [] }, workbook.rows);

const rows = [];
for (const row of localRows.filter((candidate) => candidate.state !== "EXACT")) {
  const input: CardInput = { ...row.input };
  const placeholder = isPlaceholderNumber(input.cardNumber);
  if (placeholder) delete input.cardNumber;

  const result = await runtime.resolve(placeholder ? input : { ...input, name: undefined });
  const resolved = placeholder && result.candidates.length === 1
    ? resolveCardInput(result.catalog, { ...row.input, cardNumber: result.candidates[0].cardNumber })
    : placeholder && result.candidates.length > 1
      ? resolveCardInput(result.catalog, { ...row.input, cardNumber: undefined })
      : resolveCardInput(result.catalog, row.input);
  rows.push({
    inventoryId: row.inventoryId,
    state: resolved.state,
    cardName: row.input.name,
    setSeries: row.input.setName,
    legacyCardNumber: row.input.cardNumber,
    variant: row.input.variant,
    condition: row.input.condition,
    remainingQty: row.remainingQty,
    reasons: resolved.reasons,
    candidateCount: result.candidates.length,
    candidates: result.candidates.map((candidate) => ({
      cardNumber: candidate.cardNumber,
      rarity: candidate.rarity ?? "",
      variants: candidate.variants.join(" | "),
      sourceId: candidate.sourceId,
      tcgplayerProductIds: candidate.tcgplayerProductIds.join(" | "),
    })),
  });
}

console.log(JSON.stringify({
  workbook: path,
  unresolvedLots: rows.length,
  unresolvedUnits: rows.reduce((sum, row) => sum + row.remainingQty, 0),
  rows,
}, null, 2));
