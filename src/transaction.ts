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
  lineCount: number;
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
    }, null, 2) + "\n",
    "utf8",
  );
}

function loadPendingTransactions(): void {
  if (!existsSync(pendingTransactionsPath)) return;
  try {
    const raw = readFileSync(pendingTransactionsPath, "utf8").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as PendingTransaction[] | { activeTransactionId?: string; transactions?: PendingTransaction[] };
    const transactions = Array.isArray(parsed) ? parsed : (parsed.transactions ?? []);
    activeTransactionId = Array.isArray(parsed) ? undefined : parsed.activeTransactionId;
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

  return [...pendingTransactions.values()].find((transaction) => {
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

export function getActiveTransaction(): PendingTransaction | undefined {
  const transaction = activeTransactionId ? pendingTransactions.get(activeTransactionId) : undefined;
  return transaction && transaction.status === "ACTIVE" ? transaction : undefined;
}

export function setTransactionStatus(transaction: PendingTransaction, status: InvoiceTransactionStatus): void {
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
  if (transaction.pages.some((existing) => existing.fingerprint && existing.fingerprint === page.fingerprint)) {
    throw new Error("DUPLICATE_INVOICE_PAGE");
  }

  transaction.invoice = invoice;
  transaction.plan.rows.push(...plan.rows);
  transaction.plan.insertable += plan.insertable;
  transaction.plan.pendingReview += plan.pendingReview;
  transaction.plan.skipped += plan.skipped;
  transaction.sourceAttachmentNames.push(page.attachmentName);
  transaction.pages.push(page);
  transaction.status = transaction.plan.rows.some((row) => row.input.reviewRequired) ? "PENDING_REVIEW" : "ACTIVE";
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
