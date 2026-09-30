import assert from "node:assert/strict";
import test from "node:test";
import type { InvoiceData } from "../extract.js";
import { invoicePlanToWorkbookRows } from "./workbook-persistence.js";
import type { IngestionPlan } from "./ingest.js";

const invoice: InvoiceData = {
  seller: "Test Seller",
  purchaseDate: "2026-09-30",
  orderId: "ORDER-1",
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
  currency: "USD",
  uncertainFields: [],
  lineItems: [],
};

function plan(inputOverrides: Partial<IngestionPlan["rows"][number]["input"]>): IngestionPlan {
  const input = {
    inventoryId: "IMG-ORDER-1-001",
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
    ...inputOverrides,
  };

  return {
    rows: [{
      ingestionKey: "ORDER-1:line:1",
      sourceMessageId: "ORDER-1",
      sourceLine: 1,
      action: "INSERT",
      state: input.resolutionState ?? "INCOMPLETE",
      inventoryId: input.inventoryId,
      input,
      skuId: input.skuId,
      reasons: input.resolutionReasons ?? [],
    }],
    insertable: 1,
    pendingReview: 0,
    skipped: 0,
  };
}

test("converts invoice unit costs into workbook currency without changing quantity", () => {
  const rows = invoicePlanToWorkbookRows(plan({}), invoice, { unitCostRate: 57.5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unitCost, 1.25);
  assert.equal(rows[0].qtyPurchased, 2);
  assert.equal(rows[0].totalCost, 143.75);
});

test("keeps review metadata and unresolved SKU state on workbook rows", () => {
  const rows = invoicePlanToWorkbookRows(
    plan({
      resolutionState: "INCOMPLETE",
      resolutionReasons: ["Stable identity; SKU unavailable."],
      reviewRequired: true,
      reviewFlags: ["CARD_NAME_UNCERTAIN", "QUANTITY_UNCERTAIN"],
      reviewNotes: ["Product name is difficult to read.", "Quantity is unclear."],
    }),
    invoice,
    { unitCostRate: 57.5 },
  );

  assert.deepEqual(rows[0].reviewFlags, ["CARD_NAME_UNCERTAIN", "QUANTITY_UNCERTAIN"]);
  assert.deepEqual(rows[0].reviewNotes, ["Product name is difficult to read.", "Quantity is unclear."]);
  assert.equal(rows[0].skuId, undefined);
  assert.equal(rows[0].resolutionState, "INCOMPLETE");
});

test("skips non-insert plan rows when preparing workbook persistence", () => {
  const base = plan({});
  base.rows.push({
    ...base.rows[0],
    ingestionKey: "ORDER-1:line:2",
    sourceLine: 2,
    action: "SKIP",
    input: { ...base.rows[0].input, inventoryId: "IMG-ORDER-1-002" },
  });
  base.insertable = 1;
  base.skipped = 1;

  const rows = invoicePlanToWorkbookRows(base, invoice, { unitCostRate: 57.5 });
  assert.deepEqual(rows.map((row) => row.inventoryId), ["IMG-ORDER-1-001"]);
});
