import assert from "node:assert/strict";
import test from "node:test";
import { sampleCatalog } from "../catalog/sample.js";
import { resolveInventoryLot, resolveInventoryLots, resolveInventoryRows, summarizeStates } from "./resolver.js";
import { v2InventorySample } from "./v2-sample.js";

test("resolves a V2 Charizard lot to the exact catalog SKU", () => {
  const row = v2InventorySample[0];
  const result = resolveInventoryLot(sampleCatalog, row);
  assert.equal(result.state, "EXACT");
  assert.equal(result.inventoryId, "INV-000001");
  assert.equal(result.sku?.skuId, "sku-charizard-151-006-nm");
  assert.equal(result.remainingQty, 2);
});

test("distinguishes Charizard lots by card number", () => {
  const result = resolveInventoryLots(sampleCatalog, v2InventorySample, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "199/165",
    language: "English",
    variant: "Normal",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.deepEqual(result.lots.map((lot) => lot.inventoryId), ["INV-000002"]);
});

test("uses variant to distinguish otherwise identical Pikachu inventory", () => {
  const result = resolveInventoryLots(sampleCatalog, v2InventorySample, {
    name: "Pikachu",
    setName: "Scarlet & Violet Black Star Promos",
    cardNumber: "088",
    language: "English",
    variant: "Poké Ball Pattern",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.deepEqual(result.lots.map((lot) => lot.inventoryId), ["INV-000003"]);
});

test("does not use a V2 placeholder card number to auto-resolve", () => {
  const result = resolveInventoryLot(sampleCatalog, v2InventorySample[4]);
  assert.equal(result.state, "INCOMPLETE");
  assert.equal(result.sku, undefined);
});

test("preserves name conflicts for legacy inventory", () => {
  const result = resolveInventoryLot(sampleCatalog, v2InventorySample[5]);
  assert.equal(result.state, "CONFLICT");
  assert.equal(result.sku, undefined);
});

test("keeps Inventory ID as the lot identity", () => {
  const results = resolveInventoryRows(sampleCatalog, v2InventorySample);
  assert.equal(results[0].inventoryId, "INV-000001");
  assert.equal(results[1].inventoryId, "INV-000002");
  assert.notEqual(results[0].inventoryId, results[0].sku?.skuId);
});

test("reports resolution states for manual-review cases", () => {
  const states = summarizeStates(resolveInventoryRows(sampleCatalog, v2InventorySample));
  assert.deepEqual(states, {
    EXACT: 4,
    AMBIGUOUS: 0,
    INCOMPLETE: 1,
    CONFLICT: 1,
    UNMATCHED: 0,
  });
});

test("returns no lot when an exact SKU has no available quantity", () => {
  const rows = v2InventorySample.map((row) =>
    row.inventoryId === "INV-000001" ? { ...row, remainingQty: 0 } : row,
  );
  const result = resolveInventoryLots(sampleCatalog, rows, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "006/165",
    language: "English",
    variant: "Normal",
    condition: "Near Mint",
  });
  assert.equal(result.state, "UNMATCHED");
  assert.deepEqual(result.lots, []);
});
