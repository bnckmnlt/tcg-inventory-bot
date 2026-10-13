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
    "IN STOCK\nPikachu 56/162  x6\n\nSOLD OUT\nCharizard 4/102\n",
  );
});

test("filters by inclusive purchase date range and omits quantities from sold-out cards", () => {
  const rows = [
    row({ cardName: "Pikachu", purchaseDate: "2026-01-01", remainingQty: 2, qtyPurchased: 3 }),
    row({ cardName: "Gengar", cardNumber: "1/99", purchaseDate: "2026-01-10", remainingQty: 0, qtyPurchased: 1 }),
    row({ cardName: "Mew", cardNumber: "2/99", purchaseDate: "2026-02-01", remainingQty: 1, qtyPurchased: 1 }),
  ];
  assert.equal(
    formatInventoryExport(rows, "2026-01-01", "2026-01-31"),
    "IN STOCK\nPikachu 56/162  x2\n\nSOLD OUT\nGengar 1/99\n",
  );
});

test("includes blank-date rows only when they fall between dated rows overlapping the range", () => {
  const rows = [
    row({ cardName: "Leading undated", purchaseDate: undefined }),
    row({ cardName: "January", purchaseDate: "2026-01-05" }),
    row({ cardName: "Gap row", purchaseDate: undefined, cardNumber: "57/162" }),
    row({ cardName: "February", purchaseDate: "2026-02-05" }),
    row({ cardName: "Trailing undated", purchaseDate: undefined }),
  ];

  assert.equal(
    formatInventoryExport(rows, "2026-01-20", "2026-01-31"),
    "IN STOCK\nGap row 57/162  x6\n\nSOLD OUT\n(none)\n",
  );
});

test("formats inventory sections in two aligned columns without long names shifting later rows", () => {
  const rows = [
    row({ cardName: "A very long card name that needs room", cardNumber: "1/99", remainingQty: 2 }),
    row({ cardName: "Bulbasaur", cardNumber: "2/99", remainingQty: 4 }),
    row({ cardName: "Charmander", cardNumber: "3/99", remainingQty: 1 }),
    row({ cardName: "Ditto", cardNumber: "4/99", remainingQty: 0 }),
    row({ cardName: "Eevee", cardNumber: "5/99", remainingQty: 0 }),
    row({ cardName: "Farfetch'd", cardNumber: "6/99", remainingQty: 0 }),
  ];

  assert.equal(
    formatInventoryExport(rows),
    "IN STOCK\nA very long card name that needs room 1/99  x2   Charmander 3/99  x1\nBulbasaur 2/99  x4\n\nSOLD OUT\nDitto 4/99   Farfetch'd 6/99\nEevee 5/99\n",
  );
});

test("prints empty sections without failing", () => {
  assert.equal(formatInventoryExport([]), "IN STOCK\n(none)\n\nSOLD OUT\n(none)\n");
});
