import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import type { Catalog } from "./types.js";

const path = process.argv[2] ?? "data/catalog.json";
const catalog = JSON.parse(await readFile(path, "utf8")) as Catalog;

assert.ok(catalog.sets.length > 0);
assert.ok(catalog.cards.length > 0);
assert.ok(catalog.printings.length > 0);
assert.ok(catalog.variants.length > 0);
assert.ok(catalog.skus.length > 0);

const ids = [
  ["set", catalog.sets.map((x) => x.setId)],
  ["card", catalog.cards.map((x) => x.catalogCardId)],
  ["printing", catalog.printings.map((x) => x.printingId)],
  ["variant", catalog.variants.map((x) => x.variantId)],
  ["sku", catalog.skus.map((x) => x.skuId)],
] as const;

for (const [kind, values] of ids) {
  assert.equal(new Set(values).size, values.length, kind + " IDs must be unique");
}

for (const printing of catalog.printings) {
  assert.ok(catalog.cards.some((card) => card.catalogCardId === printing.catalogCardId), "orphan printing: " + printing.printingId);
  assert.ok(catalog.sets.some((set) => set.setId === printing.setId), "orphan printing set: " + printing.printingId);
}

for (const variant of catalog.variants) {
  assert.ok(catalog.printings.some((printing) => printing.printingId === variant.printingId), "orphan variant: " + variant.variantId);
}

for (const sku of catalog.skus) {
  assert.ok(catalog.variants.some((variant) => variant.variantId === sku.variantId), "orphan SKU: " + sku.skuId);
}

const sourcePrintingIds = catalog.printings.map((printing) => printing.sourceId).filter(Boolean);
assert.equal(new Set(sourcePrintingIds).size, sourcePrintingIds.length, "TCGdex printing source IDs must be unique");

const charizard = catalog.printings.find((printing) => printing.sourceId === "sv03.5-006");
assert.ok(charizard, "Charizard ex 151 #006 fixture missing");
assert.equal(charizard.cardNumber, "006");

const charizardCard = catalog.cards.find((card) => card.catalogCardId === charizard.catalogCardId);
assert.equal(charizardCard?.canonicalName, "Charizard ex");

console.log(JSON.stringify({
  valid: true,
  path,
  sets: catalog.sets.length,
  cards: catalog.cards.length,
  printings: catalog.printings.length,
  variants: catalog.variants.length,
  skus: catalog.skus.length,
  externalIdMappings: catalog.externalIdMappings.length,
}, null, 2));
