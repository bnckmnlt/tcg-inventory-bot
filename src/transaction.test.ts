import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm } from "node:fs/promises";

process.env.INVOICE_TEST_MODE = "true";
await mkdir(".test-runtime", { recursive: true });

import type { PendingTransaction } from "./transaction.js";
import { sampleCatalog } from "./catalog/sample.js";

const {
  appendInvoicePage,
  createPendingContinuation,
  createPendingTransaction,
  findTransactionByOrderId,
  findTransactionByPageFingerprint,
  getPendingContinuation,
  listPendingTransactions,
  listContinuationTargets,
  removePendingContinuation,
  setTransactionStatus,
} = await import("./transaction.js");

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
      contentFingerprint: "content-fingerprint-1",
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
    fingerprint: "different-file-fingerprint",
    contentFingerprint: "content-fingerprint-2",
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
    fingerprint: "different-file-fingerprint",
    contentFingerprint: "content-fingerprint-1",
    lineCount: 0,
  }, emptyPlan(), target.invoice), /DUPLICATE_INVOICE_PAGE/);
});

test("runs the full invoice continuation lifecycle without creating a second transaction", () => {
  const firstPlan = {
    rows: [],
    insertable: 0,
    pendingReview: 0,
    skipped: 0,
  };
  const invoice = transaction().invoice;
  invoice.orderId = "E2E-INV-001";

  const first = createPendingTransaction(
    invoice,
    "e2e-page-1",
    ["invoice-page-1.jpg"],
    sampleCatalog,
    firstPlan,
    {
      id: "e2e-page-1",
      sourceMessageId: "e2e-page-1",
      attachmentName: "invoice-page-1.jpg",
      receivedAt: "2026-10-01T01:00:00.000Z",
      fingerprint: "e2e-fingerprint-1",
      lineCount: 0,
    },
  );

  assert.equal(first.status, "ACTIVE");
  assert.equal(first.pages.length, 1);

  const continuationPlan = {
    rows: [{
      ingestionKey: "e2e-page-2:line:1",
      sourceMessageId: "e2e-page-2",
      sourceLine: 1,
      action: "INSERT" as const,
      state: "EXACT" as const,
      input: {
        inventoryId: "IMG-e2e-page-2-001",
        cardName: "Pikachu",
        setSeries: "Base Set",
        cardNumber: "025",
        condition: "Near Mint",
        language: "English",
        variantPrinting: "Normal",
        remainingQty: 1,
        qtyPurchased: 1,
        reviewRequired: true,
      },
      reasons: ["continuation requires review"],
    }],
    insertable: 1,
    pendingReview: 1,
    skipped: 0,
  };
  const continuation = {
    id: "e2e-continuation-1",
    sourceMessageId: "e2e-page-2",
    attachmentName: "invoice-page-2.jpg",
    receivedAt: "2026-10-01T01:01:00.000Z",
    fingerprint: "e2e-fingerprint-2",
    invoice: { ...invoice, orderId: null },
    catalog: sampleCatalog,
    plan: continuationPlan,
  };

  createPendingContinuation(continuation);
  assert.equal(getPendingContinuation(continuation.id)?.id, continuation.id);

  appendInvoicePage(first, {
    id: continuation.id,
    sourceMessageId: continuation.sourceMessageId,
    attachmentName: continuation.attachmentName,
    receivedAt: continuation.receivedAt,
    fingerprint: continuation.fingerprint,
    lineCount: 1,
  }, continuation.plan, invoice);
  removePendingContinuation(continuation.id);

  assert.equal(getPendingContinuation(continuation.id), undefined);
  assert.equal(first.pages.length, 2);
  assert.equal(first.plan.rows.length, 1);
  assert.equal(first.plan.insertable, 1);
  assert.equal(first.status, "PENDING_REVIEW");
  assert.equal(listPendingTransactions().filter((item) => item.id === first.id).length, 1);

  const reviewContinuationPlan = { ...continuationPlan, rows: [], insertable: 0 };
  appendInvoicePage(first, {
    id: "e2e-page-3",
    sourceMessageId: "e2e-page-3",
    attachmentName: "invoice-page-3.jpg",
    receivedAt: "2026-10-01T01:02:00.000Z",
    fingerprint: "e2e-fingerprint-3",
    lineCount: 0,
  }, reviewContinuationPlan, invoice);
  assert.equal(first.status, "PENDING_REVIEW", "existing review state remains attached to the same invoice");

  setTransactionStatus(first, "STORED");
  assert.equal(listPendingTransactions().some((item) => item.id === first.id), false);
  assert.equal(findTransactionByPageFingerprint("e2e-fingerprint-2")?.id, first.id, "stored page history remains searchable");

  assert.throws(() => appendInvoicePage(first, {
    id: "e2e-page-2-reupload",
    sourceMessageId: "e2e-page-2-reupload",
    attachmentName: "invoice-page-2-reupload.jpg",
    receivedAt: "2026-10-01T01:03:00.000Z",
    fingerprint: "e2e-fingerprint-2",
    lineCount: 1,
  }, continuationPlan, invoice), /DUPLICATE_INVOICE_PAGE/);
});

test("allows a stored invoice to be reopened by a continuation", () => {
  const stored = createPendingTransaction(
    { ...transaction().invoice, orderId: "STORED-CONTINUATION-TARGET" },
    "stored-page-1",
    ["stored-page-1.jpg"],
    sampleCatalog,
    emptyPlan(),
  );
  setTransactionStatus(stored, "STORED");

  assert.equal(listPendingTransactions().some((item) => item.id === stored.id), false);
  assert.equal(listContinuationTargets().some((item) => item.id === stored.id), true);

  appendInvoicePage(stored, {
    id: "stored-page-2",
    sourceMessageId: "stored-page-2",
    attachmentName: "stored-page-2.jpg",
    receivedAt: "2026-10-01T02:00:00.000Z",
    fingerprint: "stored-continuation-fingerprint",
    lineCount: 1,
  }, {
    rows: [{
      ingestionKey: "stored-page-2:line:1",
      sourceMessageId: "stored-page-2",
      sourceLine: 1,
      action: "INSERT" as const,
      state: "EXACT" as const,
      input: {
        inventoryId: "IMG-stored-page-2-001",
        cardName: "Eevee",
        setSeries: "Base Set",
        cardNumber: "133",
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
  }, stored.invoice);

  assert.equal(stored.status, "PENDING_REVIEW");
  assert.equal(stored.pages.length, 2);
  assert.equal(listPendingTransactions().some((item) => item.id === stored.id), true);
  assert.equal(findTransactionByOrderId("STORED-CONTINUATION-TARGET")?.id, stored.id);
});

test("keeps an unidentified continuation held without creating an invoice", () => {
  const continuation = {
    id: "unassigned-continuation-1",
    sourceMessageId: "unassigned-page-1",
    attachmentName: "unassigned-page-1.jpg",
    receivedAt: "2026-10-01T03:00:00.000Z",
    fingerprint: "unassigned-fingerprint",
    invoice: { ...transaction().invoice, orderId: null, seller: null, purchaseDate: null, lineItems: [] },
    catalog: sampleCatalog,
    plan: emptyPlan(),
  };

  createPendingContinuation(continuation);
  assert.equal(getPendingContinuation(continuation.id)?.id, continuation.id);
  assert.equal(listPendingTransactions().some((item) => item.sourceMessageId === continuation.sourceMessageId), false);
  removePendingContinuation(continuation.id);
});

test("keeps only one invoice ACTIVE when a second invoice is started", () => {
  const plan = emptyPlan();
  const first = createPendingTransaction(transaction().invoice, "e2e-active-1", ["first.jpg"], sampleCatalog, plan);
  const second = createPendingTransaction({ ...transaction().invoice, orderId: "E2E-INV-SECOND" }, "e2e-active-2", ["second.jpg"], sampleCatalog, plan);

  assert.equal(first.status, "READY");
  assert.equal(second.status, "ACTIVE");
});

await rm(".test-runtime/pending-transactions.json", { force: true });
