import test from "node:test";
import assert from "node:assert/strict";
import { searchInventory } from "./search.js";
import type { V2InventoryRow } from "./types.js";

function row(overrides: Partial<V2InventoryRow> = {}): V2InventoryRow {
  return {
    inventoryId: "INV-1",
    cardName: "Charizard ex",
    setSeries: "Scarlet & Violet",
    cardNumber: "006",
    rarity: "Double Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 2,
    ...overrides,
  };
}

test("searches across inventory identity and purchase fields", () => {
  const results = searchInventory([
    row(),
    row({ inventoryId: "INV-2", cardName: "Pikachu", setSeries: "Surging Sparks", seller: "Alice Cards" }),
  ], "alice");
  assert.equal(results.length, 1);
  assert.equal(results[0].row.inventoryId, "INV-2");
});

test("ranks card-name matches ahead of broader matches", () => {
  const results = searchInventory([
    row({ inventoryId: "INV-1", cardName: "Charizard ex" }),
    row({ inventoryId: "INV-2", cardName: "Pikachu" }),
  ], "charizard");
  assert.equal(results[0].row.inventoryId, "INV-1");
});

test("includes sold-out records by default and can exclude them", () => {
  const results = searchInventory([
    row({ inventoryId: "SOLD", remainingQty: 0 }),
    row({ inventoryId: "LIVE", remainingQty: 1 }),
  ], "");
  assert.equal(results.length, 2);

  const available = searchInventory([
    row({ inventoryId: "SOLD", remainingQty: 0 }),
    row({ inventoryId: "LIVE", remainingQty: 1 }),
  ], "", { includeSoldOut: false });
  assert.equal(available.length, 1);
  assert.equal(available[0].row.inventoryId, "LIVE");
});

test("returns at most 25 results", () => {
  const rows = Array.from({ length: 30 }, (_, index) => row({
    inventoryId: "INV-" + index,
    cardName: "Test Card " + index,
  }));
  assert.equal(searchInventory(rows, "test").length, 25);
});
