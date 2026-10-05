import assert from "node:assert/strict";
import test from "node:test";
import type { V2InventoryRow } from "./types.js";
import { countInventoryAlerts, getInventoryAlerts } from "./alerts.js";

function row(overrides: Partial<V2InventoryRow> = {}): V2InventoryRow {
  return {
    inventoryId: "INV-1",
    cardName: "Pikachu",
    setSeries: "SV Base",
    cardNumber: "001",
    condition: "Near Mint",
    language: "EN",
    variantPrinting: "Normal",
    remainingQty: 3,
    ...overrides,
  };
}

test("detects sold out and low-stock lots", () => {
  const alerts = getInventoryAlerts([
    row({ inventoryId: "SOLD", cardName: "Sold Card", remainingQty: 0 }),
    row({ inventoryId: "LOW", cardName: "Low Card", remainingQty: 1 }),
    row({ inventoryId: "OK", cardName: "Healthy Card", remainingQty: 3 }),
  ]);

  assert.deepEqual(alerts.map((alert) => [alert.type, alert.row.inventoryId]), [
    ["SOLD_OUT", "SOLD"],
    ["LOW_STOCK", "LOW"],
  ]);
});

test("does not classify sold-out lots as low stock", () => {
  const alerts = getInventoryAlerts([row({ remainingQty: 0 })], { lowStockThreshold: 2 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "SOLD_OUT");
});

test("supports a configurable low-stock threshold", () => {
  const alerts = getInventoryAlerts([
    row({ inventoryId: "TWO", remainingQty: 2 }),
    row({ inventoryId: "THREE", remainingQty: 3 }),
  ], { lowStockThreshold: 3 });

  assert.deepEqual(alerts.map((alert) => alert.row.inventoryId), ["TWO", "THREE"]);
});

test("counts alerts by category", () => {
  assert.deepEqual(
    countInventoryAlerts([
      row({ remainingQty: 0 }),
      row({ inventoryId: "LOW-1", remainingQty: 1 }),
      row({ inventoryId: "LOW-2", remainingQty: 2 }),
      row({ inventoryId: "OK", remainingQty: 4 }),
    ]),
    { soldOut: 1, lowStock: 2, total: 3 },
  );
});
