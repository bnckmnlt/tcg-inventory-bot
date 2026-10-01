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
  findTransactionsByPageDocumentFingerprint,
  findPendingTransactionsByPageFilename,
  findTransactionByPageSimilarity,
  findPendingTransactionByPageSimilarity,
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

test("integrates 16 -> 18 -> 11 -> reupload-16 without attaching a duplicate continuation", () => {
  const invoice16 = createPendingTransaction(
    { ...transaction().invoice, orderId: "FLOW-16" },
    "flow-16",
    ["invoice-16.jpg"],
    sampleCatalog,
    emptyPlan(),
    {
      id: "flow-16-page-1",
      sourceMessageId: "flow-16",
      attachmentName: "invoice-16.jpg",
      receivedAt: "2026-10-01T04:00:00.000Z",
      fingerprint: "flow-16-file-v1",
      contentFingerprint: "flow-16-content",
      documentFingerprint: "flow-16-document",
      lineCount: 16,
    },
  );
  setTransactionStatus(invoice16, "PENDING_REVIEW");

  // The later 18-card invoice is a separate invoice. It is reviewed now and stored.
  const invoice18 = createPendingTransaction(
    { ...transaction().invoice, orderId: "FLOW-18" },
    "flow-18",
    ["invoice-18.jpg"],
    sampleCatalog,
    { rows: [], insertable: 18, pendingReview: 0, skipped: 0 },
    {
      id: "flow-18-page-1",
      sourceMessageId: "flow-18",
      attachmentName: "invoice-18.jpg",
      receivedAt: "2026-10-01T04:01:00.000Z",
      fingerprint: "flow-18-file",
      contentFingerprint: "flow-18-content",
      documentFingerprint: "flow-18-document",
      lineCount: 18,
    },
  );
  setTransactionStatus(invoice18, "PENDING_REVIEW");
  setTransactionStatus(invoice18, "STORED");

  // The 11-card invoice is reviewed later and then rejected. It must remain a separate transaction.
  const invoice11 = createPendingTransaction(
    { ...transaction().invoice, orderId: "FLOW-11" },
    "flow-11",
    ["invoice-11.jpg"],
    sampleCatalog,
    { rows: [], insertable: 11, pendingReview: 0, skipped: 0 },
    {
      id: "flow-11-page-1",
      sourceMessageId: "flow-11",
      attachmentName: "invoice-11.jpg",
      receivedAt: "2026-10-01T04:02:00.000Z",
      fingerprint: "flow-11-file",
      contentFingerprint: "flow-11-content",
      documentFingerprint: "flow-11-document",
      lineCount: 11,
    },
  );
  setTransactionStatus(invoice11, "PENDING_REVIEW");
  setTransactionStatus(invoice11, "REJECTED");

  assert.equal(invoice16.status, "PENDING_REVIEW");
  assert.equal(invoice16.pages.length, 1);
  assert.equal(invoice18.pages.length, 1);
  assert.equal(invoice11.pages.length, 1);
  assert.equal(listContinuationTargets().some((item) => item.id === invoice11.id), false);
  assert.equal(listPendingTransactions().some((item) => item.id === invoice16.id), true);
  assert.equal(listPendingTransactions().some((item) => item.id === invoice18.id), false);
  assert.equal(listPendingTransactions().some((item) => item.id === invoice11.id), false);

  // Re-uploading the original 16-card invoice has a different file fingerprint,
  // but the same document fingerprint. It must be recognized as a duplicate before
  // continuation selection can occur.
  assert.equal(findTransactionByPageFingerprint("flow-16-file-reencoded"), undefined);
  const duplicateMatches = findTransactionsByPageDocumentFingerprint("flow-16-document");
  assert.deepEqual(duplicateMatches.map((item) => item.id), [invoice16.id]);
  assert.equal(duplicateMatches[0].pages.length, 1);
  assert.equal(duplicateMatches[0].plan.insertable, 0);

  // The duplicate upload must not mutate the pending invoice into a two-page continuation.
  assert.equal(invoice16.status, "PENDING_REVIEW");
  assert.equal(invoice16.pages.length, 1);
});

test("detects a stored invoice page reupload before continuation matching", () => {
  const pageRows = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
    ingestionKey: `${prefix}:line:${index + 1}`,
    sourceMessageId: prefix,
    sourceLine: index + 1,
    action: "INSERT" as const,
    state: "EXACT" as const,
    reasons: [],
    input: {
      inventoryId: `${prefix}-${index + 1}`,
      cardName: `Card ${prefix} ${index + 1}`,
      setSeries: "Test Set",
      cardNumber: String(index + 1),
      condition: "Near Mint",
      language: "English",
      variantPrinting: "Normal",
      remainingQty: 1,
      qtyPurchased: 1,
      unitPrice: 1,
      totalPrice: 1,
      reviewRequired: false,
      reviewFlags: [],
    },
  }));

  const firstPageRows = pageRows("stored-page-1", 16);
  const continuationRows = pageRows("stored-page-2", 7);
  const stored = createPendingTransaction(
    { ...transaction().invoice, orderId: "STORED-23" },
    "stored-23",
    ["page-1.jpg"],
    sampleCatalog,
    { rows: [...firstPageRows], insertable: 16, pendingReview: 0, skipped: 0 },
    {
      id: "stored-page-1",
      sourceMessageId: "stored-23",
      attachmentName: "page-1.jpg",
      receivedAt: "2026-10-01T05:00:00.000Z",
      fingerprint: "stored-page-1-fingerprint",
      contentFingerprint: "stored-page-1-content",
      documentFingerprint: "stored-23-document",
      lineCount: 16,
    },
  );
  appendInvoicePage(stored, {
    id: "stored-page-2",
    sourceMessageId: "stored-page-2",
    attachmentName: "page-2.jpg",
    receivedAt: "2026-10-01T05:01:00.000Z",
    fingerprint: "stored-page-2-fingerprint",
    contentFingerprint: "stored-page-2-content",
    documentFingerprint: "stored-23-document",
    lineCount: 7,
  }, { rows: continuationRows, insertable: 7, pendingReview: 0, skipped: 0 }, stored.invoice);
  setTransactionStatus(stored, "STORED");

  const reuploadedPlan = { rows: firstPageRows.map((row) => ({ ...row, ingestionKey: `${row.ingestionKey}-reupload` })), insertable: 16, pendingReview: 0, skipped: 0 };
  const match = findTransactionByPageSimilarity(reuploadedPlan);

  assert.equal(match?.id, stored.id);
  assert.equal(match?.status, "STORED");
  assert.equal(match?.pages.length, 2);
});

test("detects a pending reupload when OCR loses invoice identity", () => {
  const pending = createPendingTransaction(
    { ...transaction().invoice, orderId: "OCR-LOSS-16" },
    "ocr-loss-16",
    ["ocr-loss-16.jpg"],
    sampleCatalog,
    {
      rows: [
        {
          ingestionKey: "ocr-loss-16:line:1",
          sourceMessageId: "ocr-loss-16",
          sourceLine: 1,
          action: "INSERT",
          state: "EXACT",
          input: {
            inventoryId: "OCR-LOSS-16-001",
            cardName: "Pikachu",
            setSeries: "Base Set",
            cardNumber: "025",
            condition: "Near Mint",
            language: "English",
            variantPrinting: "Normal",
            remainingQty: 2,
            qtyPurchased: 2,
            unitCost: 10,
            totalCost: 20,
          },
          reasons: [],
        },
        {
          ingestionKey: "ocr-loss-16:line:2",
          sourceMessageId: "ocr-loss-16",
          sourceLine: 2,
          action: "INSERT",
          state: "EXACT",
          input: {
            inventoryId: "OCR-LOSS-16-002",
            cardName: "Charizard",
            setSeries: "Base Set",
            cardNumber: "004",
            condition: "Near Mint",
            language: "English",
            variantPrinting: "Normal",
            remainingQty: 1,
            qtyPurchased: 1,
            unitCost: 50,
            totalCost: 50,
          },
          reasons: [],
        },
      ],
      insertable: 2,
      pendingReview: 0,
      skipped: 0,
    },
    {
      id: "ocr-loss-16-page-1",
      sourceMessageId: "ocr-loss-16",
      attachmentName: "ocr-loss-16.jpg",
      receivedAt: "2026-10-01T05:00:00.000Z",
      fingerprint: "ocr-loss-file-original",
      contentFingerprint: "ocr-loss-content-original",
      documentFingerprint: "ocr-loss-document-original",
      lineCount: 2,
    },
  );
  setTransactionStatus(pending, "PENDING_REVIEW");

  // Simulate the same physical invoice being re-extracted with seller/order/date
  // missing and a different file/document fingerprint. The purchased lines are
  // unchanged, which is the signal we can safely use before continuation logic.
  const reuploadPlan = {
    rows: pending.plan.rows.map((row) => ({
      ...row,
      sourceMessageId: "ocr-loss-reupload",
      input: {
        ...row.input,
        cardNumber: "1",
        condition: "",
        unitCost: (row.input.unitCost ?? 0) + 0.01,
        totalCost: (row.input.totalCost ?? 0) + 0.01,
      },
    })),
    insertable: 2,
    pendingReview: 0,
    skipped: 0,
  };

  const match = findPendingTransactionByPageSimilarity(reuploadPlan);
  assert.equal(match?.id, pending.id);
  assert.equal(pending.pages.length, 1);
  assert.equal(pending.status, "PENDING_REVIEW");

  // A continuation containing only one of the two original lines must not be
  // mistaken for a re-upload of the complete original page.
  const continuationPlan = {
    rows: [reuploadPlan.rows[0]],
    insertable: 1,
    pendingReview: 0,
    skipped: 0,
  };
  assert.equal(findPendingTransactionByPageSimilarity(continuationPlan), undefined);
});

test("does not guess when two pending invoices have identical page lines", () => {
  const first = createPendingTransaction(
    { ...transaction().invoice, orderId: "AMBIGUOUS-1" },
    "ambiguous-1",
    ["ambiguous-1.jpg"],
    sampleCatalog,
    { rows: [{
      ingestionKey: "ambiguous:1",
      sourceMessageId: "ambiguous-1",
      sourceLine: 1,
      action: "INSERT",
      state: "EXACT",
      input: {
        inventoryId: "AMB-001",
        cardName: "Pikachu",
        setSeries: "Base Set",
        cardNumber: "025",
        condition: "Near Mint",
        language: "English",
        variantPrinting: "Normal",
        remainingQty: 1,
        qtyPurchased: 1,
        unitCost: 10,
        totalCost: 10,
      },
      reasons: [],
    }], insertable: 1, pendingReview: 0, skipped: 0 },
    { id: "ambiguous-1-page", sourceMessageId: "ambiguous-1", attachmentName: "a.jpg", receivedAt: "2026-10-01T05:01:00.000Z", fingerprint: "amb-1", lineCount: 1 },
  );
  setTransactionStatus(first, "PENDING_REVIEW");

  const second = createPendingTransaction(
    { ...transaction().invoice, orderId: "AMBIGUOUS-2" },
    "ambiguous-2",
    ["ambiguous-2.jpg"],
    sampleCatalog,
    { rows: first.plan.rows.map((row) => ({ ...row, sourceMessageId: "ambiguous-2", input: { ...row.input, inventoryId: "AMB-002" } })), insertable: 1, pendingReview: 0, skipped: 0 },
    { id: "ambiguous-2-page", sourceMessageId: "ambiguous-2", attachmentName: "b.jpg", receivedAt: "2026-10-01T05:02:00.000Z", fingerprint: "amb-2", lineCount: 1 },
  );
  setTransactionStatus(second, "PENDING_REVIEW");

  assert.equal(findPendingTransactionByPageSimilarity(first.plan), undefined);
});

test("uses a unique attachment filename as a secondary pending duplicate signal", () => {
  const pending = createPendingTransaction(
    { ...transaction().invoice, orderId: "FILENAME-DUPLICATE-001" },
    "filename-duplicate-source",
    ["TCGPlayer Invoice 2026-10-01.jpg"],
    sampleCatalog,
    {
      rows: [{
        ingestionKey: "filename-duplicate:1",
        sourceMessageId: "filename-duplicate-source",
        sourceLine: 1,
        action: "INSERT",
        state: "EXACT",
        input: {
          inventoryId: "FILENAME-DUPLICATE-001",
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
    },
    {
      id: "filename-duplicate-page",
      sourceMessageId: "filename-duplicate-source",
      attachmentName: "TCGPlayer Invoice 2026-10-01.jpg",
      receivedAt: "2026-10-01T06:00:00.000Z",
      fingerprint: "filename-original-fingerprint",
      lineCount: 1,
    },
  );
  setTransactionStatus(pending, "PENDING_REVIEW");

  const matches = findPendingTransactionsByPageFilename(
    "  tcgplayer   invoice 2026-10-01.jpg ",
    1,
  );
  assert.deepEqual(matches.map((item) => item.id), [pending.id]);

  // A filename match with a different extracted line count is not strong
  // enough to suppress a real continuation.
  assert.deepEqual(
    findPendingTransactionsByPageFilename("TCGPlayer Invoice 2026-10-01.jpg", 2),
    [],
  );
});

test("does not guess when a filename is shared by multiple pending invoices", () => {
  const first = createPendingTransaction(
    { ...transaction().invoice, orderId: "FILENAME-AMBIGUOUS-1" },
    "filename-ambiguous-1",
    ["invoice.jpg"],
    sampleCatalog,
    emptyPlan(),
    {
      id: "filename-ambiguous-page-1",
      sourceMessageId: "filename-ambiguous-1",
      attachmentName: "invoice.jpg",
      receivedAt: "2026-10-01T06:01:00.000Z",
      fingerprint: "filename-ambiguous-1",
      lineCount: 2,
    },
  );
  setTransactionStatus(first, "PENDING_REVIEW");

  const second = createPendingTransaction(
    { ...transaction().invoice, orderId: "FILENAME-AMBIGUOUS-2" },
    "filename-ambiguous-2",
    ["invoice.jpg"],
    sampleCatalog,
    emptyPlan(),
    {
      id: "filename-ambiguous-page-2",
      sourceMessageId: "filename-ambiguous-2",
      attachmentName: "invoice.jpg",
      receivedAt: "2026-10-01T06:02:00.000Z",
      fingerprint: "filename-ambiguous-2",
      lineCount: 2,
    },
  );
  setTransactionStatus(second, "PENDING_REVIEW");

  assert.deepEqual(
    findPendingTransactionsByPageFilename("invoice.jpg", 2).map((item) => item.id),
    [first.id, second.id],
  );
});

test("detects a reuploaded stored page by document fingerprint", () => {
  const stored = createPendingTransaction(
    { ...transaction().invoice, orderId: "DOC-FINGERPRINT-001" },
    "doc-page-1",
    ["doc-page-1.jpg"],
    sampleCatalog,
    emptyPlan(),
    {
      id: "doc-page-1",
      sourceMessageId: "doc-page-1",
      attachmentName: "doc-page-1.jpg",
      receivedAt: "2026-10-01T03:00:00.000Z",
      fingerprint: "doc-file-original",
      contentFingerprint: "doc-content-001",
      documentFingerprint: "doc-document-001",
      lineCount: 16,
    },
  );
  setTransactionStatus(stored, "STORED");

  const matches = findTransactionsByPageDocumentFingerprint("doc-document-001");
  assert.deepEqual(matches.map((item) => item.id), [stored.id]);
  assert.equal(findTransactionByPageFingerprint("doc-file-reencoded"), undefined);

  assert.equal(
    findTransactionsByPageDocumentFingerprint("doc-document-missing").length,
    0,
  );
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
