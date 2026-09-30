import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsonInventoryStore } from "./json-store.js";

test("persists inserted inventory rows and reloads them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tcg-inventory-"));
  const file = path.join(dir, "inventory.json");
  const store = await createJsonInventoryStore(file);

  await store.apply([{
    ingestionKey: "msg:line:1",
    sourceMessageId: "msg",
    sourceLine: 1,
    action: "INSERT",
    state: "EXACT",
    inventoryId: "IMG-msg-001",
    skuId: "sku-1",
    input: {
      inventoryId: "IMG-msg-001",
      cardName: "Pikachu",
      setSeries: "Test Set",
      cardNumber: "001",
      condition: "Near Mint",
      language: "English",
      variantPrinting: "Normal",
      remainingQty: 2,
      qtyPurchased: 2,
      unitCost: 1.25,
      totalCost: 2.5,
    },
    reasons: ["Exact catalog SKU verified."],
  }]);

  const raw = JSON.parse(await readFile(file, "utf8")) as unknown[];
  assert.equal(raw.length, 1);

  const reloaded = await createJsonInventoryStore(file);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].inventoryId, "IMG-msg-001");
});

test("does not create a file when a plan has no inserts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tcg-inventory-"));
  const file = path.join(dir, "inventory.json");
  const store = await createJsonInventoryStore(file);

  const result = await store.apply([{
    ingestionKey: "msg:line:1",
    sourceMessageId: "msg",
    sourceLine: 1,
    action: "PENDING_REVIEW",
    state: "INCOMPLETE",
    inventoryId: "IMG-msg-001",
    input: {
      inventoryId: "IMG-msg-001",
      cardName: "Pikachu",
      setSeries: "Test Set",
      cardNumber: "",
      condition: "",
      language: "English",
      variantPrinting: "Normal",
      remainingQty: 1,
    },
    reasons: ["Missing required fields."],
  }]);

  assert.deepEqual(result, { inserted: 0, skipped: 0, pendingReview: 1 });
  await assert.rejects(readFile(file, "utf8"));
});
