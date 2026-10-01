import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InvoiceData } from "./extract.js";
import { purchaseIdentityKeys, type IngestionPlan } from "./inventory/ingest.js";
import type { Catalog } from "./catalog/types.js";

export type InvoiceTransactionStatus =
  | "ACTIVE"
  | "PENDING_REVIEW"
  | "READY"
  | "STORED"
  | "REJECTED"
  | "NEEDS_INVOICE_SELECTION";

export interface InvoicePage {
  id: string;
  sourceMessageId: string;
  attachmentName: string;
  receivedAt: string;
  fingerprint: string;
  contentFingerprint?: string;
  documentFingerprint?: string;
  lineCount: number;
}

export interface PendingContinuation {
  id: string;
  sourceMessageId: string;
  attachmentName: string;
  receivedAt: string;
  fingerprint: string;
  contentFingerprint?: string;
  documentFingerprint?: string;
  invoice: InvoiceData;
  catalog: Catalog;
  plan: IngestionPlan;
}

export interface PendingTransaction {
  id: string;
  invoice: InvoiceData;
  sourceMessageId: string;
  sourceAttachmentNames: string[];
  catalog: Catalog;
  plan: IngestionPlan;
  status: InvoiceTransactionStatus;
  pages: InvoicePage[];
}

const pendingTransactions = new Map<string, PendingTransaction>();
const pendingContinuations = new Map<string, PendingContinuation>();
let activeTransactionId: string | undefined;
const pendingTransactionsPath = process.env.INVOICE_TEST_MODE === "true"
  ? path.resolve(".test-runtime/pending-transactions.json")
  : path.resolve("data/pending-transactions.json");

function savePendingTransactions(): void {
  writeFileSync(
    pendingTransactionsPath,
    JSON.stringify({
      activeTransactionId,
      transactions: [...pendingTransactions.values()],
      continuations: [...pendingContinuations.values()],
    }, null, 2) + "\n",
    "utf8",
  );
}

function loadPendingTransactions(): void {
  if (!existsSync(pendingTransactionsPath)) return;
  try {
    const raw = readFileSync(pendingTransactionsPath, "utf8").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as PendingTransaction[] | {
      activeTransactionId?: string;
      transactions?: PendingTransaction[];
      continuations?: PendingContinuation[];
    };
    const transactions = Array.isArray(parsed) ? parsed : (parsed.transactions ?? []);
    const continuations = Array.isArray(parsed) ? [] : (parsed.continuations ?? []);
    activeTransactionId = Array.isArray(parsed) ? undefined : parsed.activeTransactionId;
    for (const continuation of continuations) {
      if (continuation?.id) pendingContinuations.set(continuation.id, continuation);
    }
    for (const transaction of transactions) {
      if (!transaction?.id) continue;
      transaction.status ??= transaction.plan.rows.some((row) => row.input.reviewRequired)
        ? "PENDING_REVIEW"
        : "READY";
      transaction.pages ??= [{
        id: transaction.sourceMessageId,
        sourceMessageId: transaction.sourceMessageId,
        attachmentName: transaction.sourceAttachmentNames[0] ?? "invoice",
        receivedAt: new Date().toISOString(),
        fingerprint: "",
        lineCount: transaction.plan.rows.length,
      }];
      pendingTransactions.set(transaction.id, transaction);
    }
    if (!activeTransactionId) {
      const active = [...pendingTransactions.values()].find((transaction) => transaction.status === "ACTIVE");
      activeTransactionId = active?.id;
    }
  } catch (error) {
    console.error("Failed to load pending invoice reviews:", error);
  }
}

loadPendingTransactions();

export function createPendingTransaction(
  invoice: InvoiceData,
  sourceMessageId: string,
  sourceAttachmentNames: string[],
  catalog: Catalog,
  plan: IngestionPlan,
  page?: InvoicePage,
): PendingTransaction {
  const needsReview = plan.rows.some((row) => row.input.reviewRequired);
  const transaction: PendingTransaction = {
    id: randomUUID(),
    invoice,
    sourceMessageId,
    sourceAttachmentNames,
    catalog,
    plan,
    status: needsReview ? "PENDING_REVIEW" : "ACTIVE",
    pages: [page ?? {
      id: sourceMessageId,
      sourceMessageId,
      attachmentName: sourceAttachmentNames[0] ?? "invoice",
      receivedAt: new Date().toISOString(),
      fingerprint: "",
      lineCount: plan.rows.length,
    }],
  };

  if (transaction.status === "ACTIVE" && activeTransactionId && activeTransactionId !== transaction.id) {
    const previousActive = pendingTransactions.get(activeTransactionId);
    if (previousActive && previousActive.status === "ACTIVE") previousActive.status = "READY";
  }
  pendingTransactions.set(transaction.id, transaction);
  if (transaction.status === "ACTIVE") activeTransactionId = transaction.id;
  savePendingTransactions();
  return transaction;
}

export function getPendingTransaction(id: string): PendingTransaction | undefined {
  return pendingTransactions.get(id);
}

export function getPendingTransactionBySourceMessageId(sourceMessageId: string): PendingTransaction | undefined {
  return [...pendingTransactions.values()].find((transaction) => transaction.sourceMessageId === sourceMessageId);
}

function pendingPurchaseKeys(transaction: PendingTransaction): Set<string> {
  const keys = new Set<string>();
  for (const row of transaction.plan.rows) {
    if (row.action === "SKIP") continue;
    for (const key of purchaseIdentityKeys(row.input)) keys.add(key);
  }
  return keys;
}

/**
 * Finds an existing pending review for the same purchased invoice, even when
 * the user reuploads the invoice and Discord gives it a new message ID.
 *
 * The relaxed purchase identity deliberately ignores card number so an
 * uncertain extraction cannot create a second pending transaction for the
 * same invoice.
 */
export function getPendingTransactionByPurchaseIdentity(
  plan: IngestionPlan,
): PendingTransaction | undefined {
  const incomingKeys = new Set<string>();
  for (const row of plan.rows) {
    if (row.action === "SKIP") continue;
    for (const key of purchaseIdentityKeys(row.input)) {
      if (key.startsWith("order:") || key.startsWith("fallback-relaxed:")) {
        incomingKeys.add(key);
      }
    }
  }

  if (incomingKeys.size === 0) return undefined;

  return listPendingTransactions().find((transaction) => {
    const existingKeys = pendingPurchaseKeys(transaction);
    for (const key of incomingKeys) {
      if (existingKeys.has(key)) return true;
    }
    return false;
  });
}

export function listPendingTransactions(): PendingTransaction[] {
  return [...pendingTransactions.values()].filter((transaction) => transaction.status !== "STORED" && transaction.status !== "REJECTED");
}

export function listContinuationTargets(): PendingTransaction[] {
  const statusOrder: Record<InvoiceTransactionStatus, number> = {
    ACTIVE: 0, PENDING_REVIEW: 1, READY: 2, STORED: 3, REJECTED: 4, NEEDS_INVOICE_SELECTION: 5,
  };
  return [...pendingTransactions.values()]
    .filter((transaction) => transaction.status !== "REJECTED")
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
}

export function findTransactionByPageFingerprint(fingerprint: string): PendingTransaction | undefined {
  if (!fingerprint) return undefined;
  return [...pendingTransactions.values()].find((transaction) =>
    transaction.pages.some((page) => page.fingerprint === fingerprint),
  );
}

export function findTransactionsByPageDocumentFingerprint(documentFingerprint: string): PendingTransaction[] {
  if (!documentFingerprint) return [];
  return [...pendingTransactions.values()].filter((transaction) =>
    transaction.pages.some((page) => page.documentFingerprint === documentFingerprint),
  );
}

function normalizeAttachmentName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Finds non-rejected invoice history that already contains a page with the
 * same attachment filename. Filename is a secondary duplicate signal: it is
 * useful when OCR or file-content fingerprints change, including for STORED
 * transactions. The full candidate list is returned so callers never guess
 * when multiple invoices share a name.
 */
export function findTransactionsByPageFilename(
  attachmentName: string,
  lineCount?: number,
): PendingTransaction[] {
  const normalized = normalizeAttachmentName(attachmentName);
  if (!normalized) return [];

  return [...pendingTransactions.values()]
    .filter((transaction) => transaction.status !== "REJECTED")
    .filter((transaction) => transaction.pages.some((page) =>
      normalizeAttachmentName(page.attachmentName) === normalized &&
      (lineCount === undefined || page.lineCount === lineCount),
    ));
}

/**
 * Backward-compatible pending-only filename lookup for callers that need to
 * distinguish an open review from historical duplicate detection.
 */
export function findPendingTransactionsByPageFilename(
  attachmentName: string,
  lineCount?: number,
): PendingTransaction[] {
  return findTransactionsByPageFilename(attachmentName, lineCount)
    .filter((transaction) => transaction.status !== "STORED");
}

function normalizeSimilarityPart(value: string | number | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function invoiceLineSimilarityKey(row: IngestionPlan["rows"][number]): string {
  const input = row.input;
  // OCR can legitimately vary on card number, price, condition wording, or
  // minor formatting on a re-upload. Use the stable purchase fields that are
  // least likely to change between scans; card number is deliberately excluded.
  return [
    normalizeSimilarityPart(input.cardName),
    normalizeSimilarityPart(input.setSeries),
    normalizeSimilarityPart(input.qtyPurchased),
  ].join("|");
}

/**
 * Finds a unique pending invoice whose existing page has the same extracted
 * purchase lines as an incoming re-upload. Card number is intentionally not
 * part of the comparison because OCR can lose or alter it on re-upload.
 *
 * This is only used as a duplicate guard before continuation detection. A
 * match must cover the complete page line-for-line, and ambiguous matches are
 * rejected rather than guessed so two genuinely identical invoices cannot be
 * silently merged.
 */
export function findTransactionByPageSimilarity(
  incomingPlan: IngestionPlan,
): PendingTransaction | undefined {
  const incomingRows = incomingPlan.rows.filter((row) => row.action !== "SKIP");
  if (incomingRows.length === 0) return undefined;

  const incomingKeys = incomingRows.map(invoiceLineSimilarityKey);
  const candidates: PendingTransaction[] = [];

  for (const transaction of [...pendingTransactions.values()].filter((item) => item.status !== "REJECTED")) {
    let offset = 0;
    for (const page of transaction.pages) {
      const pageRows = transaction.plan.rows.slice(offset, offset + page.lineCount)
        .filter((row) => row.action !== "SKIP");
      offset += page.lineCount;

      if (pageRows.length !== incomingRows.length) continue;

      const remaining = pageRows.map(invoiceLineSimilarityKey);
      let matched = true;
      for (const incomingKey of incomingKeys) {
        const index = remaining.indexOf(incomingKey);
        if (index < 0) {
          matched = false;
          break;
        }
        remaining.splice(index, 1);
      }
      if (matched) {
        candidates.push(transaction);
        break;
      }
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

export function findPendingTransactionByPageSimilarity(
  incomingPlan: IngestionPlan,
): PendingTransaction | undefined {
  const candidates = [...pendingTransactions.values()].filter((transaction) => transaction.status !== "STORED" && transaction.status !== "REJECTED");
  const incomingRows = incomingPlan.rows.filter((row) => row.action !== "SKIP");
  if (incomingRows.length === 0) return undefined;

  const incomingKeys = incomingRows.map(invoiceLineSimilarityKey);
  const matches: PendingTransaction[] = [];
  for (const transaction of candidates) {
    let offset = 0;
    for (const page of transaction.pages) {
      const pageRows = transaction.plan.rows.slice(offset, offset + page.lineCount).filter((row) => row.action !== "SKIP");
      offset += page.lineCount;
      if (pageRows.length !== incomingRows.length) continue;
      const remaining = pageRows.map(invoiceLineSimilarityKey);
      if (incomingKeys.every((key) => { const index = remaining.indexOf(key); if (index < 0) return false; remaining.splice(index, 1); return true; })) {
        matches.push(transaction);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function createPendingContinuation(continuation: PendingContinuation): void {
  pendingContinuations.set(continuation.id, continuation);
  savePendingTransactions();
}

export function getPendingContinuation(id: string): PendingContinuation | undefined {
  return pendingContinuations.get(id);
}

export function listPendingContinuations(): PendingContinuation[] {
  return [...pendingContinuations.values()];
}

export function removePendingContinuation(id: string): void {
  if (!pendingContinuations.delete(id)) return;
  savePendingTransactions();
}

export function findTransactionByOrderId(orderId: string): PendingTransaction | undefined {
  const normalized = orderId.trim().toLowerCase();
  if (!normalized) return undefined;
  return listContinuationTargets().find((transaction) => transaction.invoice.orderId?.trim().toLowerCase() === normalized);
}

export function getActiveTransaction(): PendingTransaction | undefined {
  const transaction = activeTransactionId ? pendingTransactions.get(activeTransactionId) : undefined;
  return transaction && transaction.status === "ACTIVE" ? transaction : undefined;
}

export function setTransactionStatus(transaction: PendingTransaction, status: InvoiceTransactionStatus): void {
  if (status === "ACTIVE" && activeTransactionId && activeTransactionId !== transaction.id) {
    const previousActive = pendingTransactions.get(activeTransactionId);
    if (previousActive && previousActive.status === "ACTIVE") previousActive.status = "READY";
  }
  transaction.status = status;
  if (status === "ACTIVE") activeTransactionId = transaction.id;
  else if (activeTransactionId === transaction.id) activeTransactionId = undefined;
  savePendingTransactions();
}

export function appendInvoicePage(
  transaction: PendingTransaction,
  page: InvoicePage,
  plan: IngestionPlan,
  invoice: InvoiceData,
): PendingTransaction {
  if (transaction.pages.some((existing) =>
    (existing.fingerprint && existing.fingerprint === page.fingerprint) ||
    (existing.contentFingerprint && page.contentFingerprint && existing.contentFingerprint === page.contentFingerprint)
  )) {
    throw new Error("DUPLICATE_INVOICE_PAGE");
  }

  transaction.invoice = invoice;
  transaction.plan.rows.push(...plan.rows);
  transaction.plan.insertable += plan.insertable;
  transaction.plan.pendingReview += plan.pendingReview;
  transaction.plan.skipped += plan.skipped;
  transaction.sourceAttachmentNames.push(page.attachmentName);
  transaction.pages.push(page);
  const hasReviewIssues = transaction.plan.rows.some((row) => row.input.reviewRequired);
  const wasStored = transaction.status === "STORED";
  const wasPendingReview = transaction.status === "PENDING_REVIEW";
  transaction.status = hasReviewIssues || wasStored || wasPendingReview ? "PENDING_REVIEW" : "ACTIVE";
  activeTransactionId = transaction.status === "ACTIVE" ? transaction.id : undefined;
  savePendingTransactions();
  return transaction;
}

export function removePendingTransaction(id: string): void {
  if (!pendingTransactions.delete(id)) return;
  savePendingTransactions();
}

export function savePendingTransaction(transaction: PendingTransaction): void {
  pendingTransactions.set(transaction.id, transaction);
  savePendingTransactions();
}
