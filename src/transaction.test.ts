import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";

process.env.INVOICE_TEST_MODE = "true";
await mkdir(".test-runtime", { recursive: true });

import type { PendingTransaction } from "./transaction.js";
import { sampleCatalog } from "./catalog/sample.js";

const { appendInvoicePage } = await import("./transaction.js");

const emptyPlan = () => ({
  rows: [],
  insertable: 0,
  pendingReview: 0,
  skipped: 0,
});

function transaction(): PendingTransaction {
  return {
    id: "tx-1",
    invoice: {
      seller: "Seller",
      purchaseDate: "2026-10-01",
      orderId: "INV-1",
      subtotal: null,
      shipping: null,
      tax: null,
      total: null,
      currency: "PHP",
      lineItems: [],
      uncertainFields: [],
    },
    sourceMessageId: "msg-1",
    sourceAttachmentNames: ["page-1.jpg"],
    catalog: sampleCatalog,
    plan: emptyPlan(),
    status: "ACTIVE",
    pages: [{
      id: "page-1",
      sourceMessageId: "msg-1",
      attachmentName: "page-1.jpg",
      receivedAt: "2026-10-01T00:00:00.000Z",
      fingerprint: "fingerprint-1",
      lineCount: 0,
    }],
  };
}

test("attaches a continuation page and updates invoice state", () => {
  const target = transaction();
  const plan = {
    rows: [{
      ingestionKey: "page-2:line:2",
      sourceMessageId: "page-2",
      sourceLine: 2,
      action: "INSERT" as const,
      state: "EXACT" as const,
      input: {
        inventoryId: "IMG-page-2-002",
        cardName: "Pikachu",
        setSeries: "Base Set",
        cardNumber: "025",
        condition: "Near Mint",
        language: "English",
        variantPrinting: "Normal",
        remainingQty: 1,
        qtyPurchased: 1,
      },
      reasons: [],
    }],
    insertable: 1,
    pendingReview: 0,
    skipped: 0,
  };

  appendInvoicePage(target, {
    id: "page-2",
    sourceMessageId: "page-2",
    attachmentName: "page-2.jpg",
    receivedAt: "2026-10-01T00:01:00.000Z",
    fingerprint: "fingerprint-2",
    lineCount: 1,
  }, plan, target.invoice);

  assert.equal(target.plan.rows.length, 1);
  assert.equal(target.plan.insertable, 1);
  assert.equal(target.pages.length, 2);
  assert.equal(target.status, "ACTIVE");
});

test("rejects a continuation page whose fingerprint is already attached", () => {
  const target = transaction();
  assert.throws(() => appendInvoicePage(target, {
    id: "page-duplicate",
    sourceMessageId: "page-duplicate",
    attachmentName: "duplicate.jpg",
    receivedAt: "2026-10-01T00:02:00.000Z",
    fingerprint: "fingerprint-1",
    lineCount: 0,
  }, emptyPlan(), target.invoice), /DUPLICATE_INVOICE_PAGE/);
});

await rm(".test-runtime/pending-transactions.json", { force: true });
