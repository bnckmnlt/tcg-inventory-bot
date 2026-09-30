import { readFileSync } from "node:fs";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { resolveInventoryRows } from "./resolver.js";
import { normalizeSetName, normalizeText, normalizeVariant } from "../catalog/normalize.js";
import type { Catalog } from "../catalog/types.js";

function baseName(value: string): string {
  return normalizeText(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function variantMatches(label: string, requested: string): boolean {
  const a = normalizeVariant(label);
  const b = normalizeVariant(requested);
  if (a === b) return true;
  if (b === "Normal") return a === "Normal" || a === "normal";
  return a.includes(b) || b.includes(a);
}

const path = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!path) {
  console.error("Usage: npm run inventory:review -- <path-to-v2-xlsx>");
  process.exit(2);
}

const workbook = readV2InventoryWorkbook(path);
const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8")) as Catalog;
const resolved = resolveInventoryRows(catalog, workbook.rows);

const rows = resolved
  .filter((row) => row.state !== "EXACT")
  .map((row) => {
    const set = normalizeSetName(row.input.setName);
    const name = baseName(row.input.name ?? "");
    const candidates = catalog.printings
      .filter((printing) => normalizeSetName(printing.setName) === set)
      .filter((printing) => baseName(catalog.cards.find((card) => card.catalogCardId === printing.catalogCardId)?.canonicalName ?? "") === name)
      .map((printing) => {
        const card = catalog.cards.find((candidate) => candidate.catalogCardId === printing.catalogCardId)!;
        const variants = catalog.variants.filter((variant) => variant.printingId === printing.printingId);
        const matchingVariants = variants.filter((variant) => variantMatches(variant.variantLabel, row.input.variant ?? "Normal"));
        const variantList = (matchingVariants.length ? matchingVariants : variants).map((variant) => variant.variantLabel);
        const tcgplayerIds = catalog.externalIdMappings
          .filter((mapping) => mapping.entityType === "variant" && mapping.internalId === (matchingVariants[0]?.variantId ?? variants[0]?.variantId) && mapping.source === "tcgplayer")
          .map((mapping) => mapping.externalId);
        return {
          cardNumber: printing.cardNumber,
          rarity: printing.rarity ?? "",
          variants: variantList.join(" | "),
          sourceId: printing.sourceId ?? "",
          tcgplayerProductIds: tcgplayerIds.join(" | "),
          cardId: card.catalogCardId,
        };
      });

    return {
      inventoryId: row.inventoryId,
      state: row.state,
      cardName: row.input.name ?? "",
      setSeries: row.input.setName ?? "",
      legacyCardNumber: row.input.cardNumber ?? "",
      variant: row.input.variant ?? "Normal",
      condition: row.input.condition ?? "",
      remainingQty: row.remainingQty,
      candidateCount: candidates.length,
      candidates,
      reasons: row.reasons,
    };
  });

console.log(JSON.stringify({
  workbook: path,
  unresolvedLots: rows.length,
  unresolvedUnits: rows.reduce((sum, row) => sum + row.remainingQty, 0),
  rows,
}, null, 2));
