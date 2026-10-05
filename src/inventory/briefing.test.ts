import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedV2InventoryRow } from "./v2-workbook.js";
import { buildInventoryBriefing } from "./briefing.js";

function row(overrides: Partial<ParsedV2InventoryRow> = {}): ParsedV2InventoryRow {
  return {
    sourceRow: 4,
    rawCardKey: "KEY",
    raw: {},
    inventoryId: "INV-1",
    cardName: "Pikachu",
    setSeries: "SV Base",
    cardNumber: "001",
    rarity: "Rare",
    condition: "Near Mint",
    language: "EN",
    variantPrinting: "Normal",
    remainingQty: 2,
    qtyPurchased: 5,
    unitCost: 100,
    ...overrides,
  };
}

test("aggregates inventory cost, sales, stock, and sell-through", () => {
  const result = buildInventoryBriefing([
    row({ raw: { "Qty Sold": 3, "Total Cost (₱)": 500, "Total Revenue (₱)": 900, "Realized Profit / Loss (₱)": 400 } }),
    row({ inventoryId: "INV-2", cardName: "Charizard", remainingQty: 0, qtyPurchased: 2, unitCost: 200, raw: { "Qty Sold": 2, "Total Cost (₱)": 400, "Total Revenue (₱)": 700, "Realized Profit / Loss (₱)": 300 } }),
  ]);

  assert.equal(result.lots, 2);
  assert.equal(result.qtyPurchased, 7);
  assert.equal(result.qtySold, 5);
  assert.equal(result.remainingQty, 2);
  assert.equal(result.totalCost, 900);
  assert.equal(result.remainingCost, 200);
  assert.equal(result.revenue, 1600);
  assert.equal(result.realizedProfit, 700);
  assert.equal(result.soldThroughPct, 5 / 7 * 100);
  assert.equal(result.soldOutLots, 1);
  assert.equal(result.lowStockLots, 1);
});

test("ranks best-selling cards and top suppliers", () => {
  const result = buildInventoryBriefing([
    row({ seller: "Seller A", cardName: "Pikachu", raw: { "Qty Sold": 4, "Total Revenue (₱)": 800 } }),
    row({ inventoryId: "INV-2", seller: "Seller A", cardName: "Pikachu", raw: { "Qty Sold": 2, "Total Revenue (₱)": 500 } }),
    row({ inventoryId: "INV-3", seller: "Seller B", cardName: "Charizard", qtyPurchased: 11, raw: { "Qty Sold": 3, "Total Revenue (₱)": 900 } }),
  ]);

  assert.equal(result.bestSellers[0].cardName, "Pikachu");
  assert.equal(result.bestSellers[0].qtySold, 6);
  assert.equal(result.topSellers[0].seller, "Seller B");
  assert.equal(result.topSellers[0].qtyPurchased, 11);
});
