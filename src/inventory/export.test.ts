import assert from "node:assert/strict";
import test from "node:test";
import { formatInventoryExport, buildInventoryExport } from "./export.js";
import type { ParsedV2InventoryRow } from "./v2-workbook.js";

function row(overrides: Partial<ParsedV2InventoryRow> = {}): ParsedV2InventoryRow {
  return {
    sourceRow: 2,
    rawCardKey: "",
    inventoryId: "INV-1",
    cardName: "Pikachu",
    setSeries: "Scarlet & Violet",
    cardNumber: "56/162",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 6,
    qtyPurchased: 6,
    unitCost: 10,
    raw: {},
    ...overrides,
  };
}

test("aggregates lots by card name and number and separates remaining stock from sold-out cards", () => {
  const rows = [
    row({ inventoryId: "INV-1", qtyPurchased: 4, remainingQty: 2 }),
    row({ inventoryId: "INV-2", qtyPurchased: 4, remainingQty: 4 }),
    row({ inventoryId: "INV-3", cardName: "Charizard", cardNumber: "4/102", qtyPurchased: 3, remainingQty: 0 }),
    row({ inventoryId: "INV-4", cardName: "Unpurchased", qtyPurchased: 0, remainingQty: 0 }),
  ];
  assert.deepEqual(buildInventoryExport(rows), [
    { cardName: "Charizard", cardNumber: "4/102", purchased: 3, remaining: 0 },
    { cardName: "Pikachu", cardNumber: "56/162", purchased: 8, remaining: 6 },
  ]);
  assert.equal(
    formatInventoryExport(rows),
    "IN STOCK\nx6 Pikachu 56/162\n\nSOLD OUT\nx0 Charizard 4/102\n",
  );
});

test("prints empty sections without failing", () => {
  assert.equal(formatInventoryExport([]), "IN STOCK\n(none)\n\nSOLD OUT\n(none)\n");
});
