import assert from "node:assert/strict";
import test from "node:test";
import { parseV2InventorySheet, toResolverInventoryRows, V2_INVENTORY_HEADERS } from "./v2-workbook.js";

function row(values: Record<string, unknown>): unknown[] {
  return V2_INVENTORY_HEADERS.map((header) => values[header]);
}

test("parses V2 Inventory rows into resolver-ready lots", () => {
  const result = parseV2InventorySheet([
    [...V2_INVENTORY_HEADERS],
    row({
      "Inventory ID": "INV-000001",
      "Card Key": "old|mutable|key",
      "Card Name": "Charizard ex",
      "Set / Series": "151",
      "Card Number": "006/165",
      "Rarity": "Double rare",
      "Condition": "Near Mint",
      "Language": "English",
      "Variant / Printing": "Normal",
      "Qty Purchased": 2,
      "Unit Cost (₱ each)": 100,
      "Remaining Qty": 2,
    }),
  ]);

  assert.equal(result.issues.length, 0);
  assert.equal(result.rows[0].inventoryId, "INV-000001");
  assert.equal(result.rows[0].rawCardKey, "old|mutable|key");
  assert.equal(result.rows[0].qtyPurchased, 2);
  assert.equal(toResolverInventoryRows(result.rows)[0].inventoryId, "INV-000001");
});

test("reports missing identity and accounting fields without discarding the row", () => {
  const result = parseV2InventorySheet([
    [...V2_INVENTORY_HEADERS],
    row({
      "Inventory ID": "INV-000002",
      "Card Name": "",
      "Set / Series": "151",
      "Card Number": "1",
      "Condition": "",
      "Language": "English",
      "Qty Purchased": 1,
      "Unit Cost (₱ each)": 50,
      "Remaining Qty": 1,
    }),
  ]);

  assert.ok(result.rows.length === 1);
  assert.ok(result.issues.some((issue) => issue.field === "cardName"));
  assert.ok(result.issues.some((issue) => issue.field === "condition"));
});

test("derives Remaining Qty when Google Sheets returns a blank formula result", () => {
  const result = parseV2InventorySheet([
    [...V2_INVENTORY_HEADERS],
    row({
      "Inventory ID": "INV-000005",
      "Card Name": "Pikachu",
      "Set / Series": "151",
      "Card Number": "025",
      "Condition": "Near Mint",
      "Language": "English",
      "Qty Purchased": 3,
      "Qty Sold": 1,
      "Unit Cost (₱ each)": 20,
      "Remaining Qty": "",
    }),
  ]);

  assert.equal(result.issues.length, 0);
  assert.equal(result.rows[0].remainingQty, 2);
});

test("defaults a blank V2 variant to Normal", () => {
  const result = parseV2InventorySheet([
    [...V2_INVENTORY_HEADERS],
    row({
      "Inventory ID": "INV-000003",
      "Card Name": "Pikachu",
      "Set / Series": "Scarlet & Violet Black Star Promos",
      "Card Number": "088",
      "Condition": "Near Mint",
      "Language": "English",
      "Variant / Printing": "",
      "Qty Purchased": 1,
      "Unit Cost (₱ each)": 20,
      "Remaining Qty": 1,
    }),
  ]);

  assert.equal(result.rows[0].variantPrinting, "Normal");
});

test("rejects a workbook with missing V2 headers", () => {
  const result = parseV2InventorySheet([["Inventory ID", "Card Name"], ["INV-000001", "Pikachu"]]);
  assert.equal(result.rows.length, 0);
  assert.match(result.issues[0].message, /Missing V2 Inventory headers/);
});

test("ignores completely blank rows", () => {
  const result = parseV2InventorySheet([
    [...V2_INVENTORY_HEADERS],
    [],
    row({
      "Inventory ID": "INV-000004",
      "Card Name": "Pikachu",
      "Set / Series": "Scarlet & Violet Black Star Promos",
      "Card Number": "088",
      "Condition": "Near Mint",
      "Language": "English",
      "Qty Purchased": 1,
      "Unit Cost (₱ each)": 20,
      "Remaining Qty": 1,
    }),
  ]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sourceRow, 3);
});
