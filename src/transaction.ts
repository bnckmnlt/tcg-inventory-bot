import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InvoiceData } from "./extract.js";
import { purchaseIdentityKeys, type IngestionPlan } from "./inventory/ingest.js";
import type { Catalog } from "./catalog/types.js";

export interface PendingTransaction {
  id: string;
  invoice: InvoiceData;
  sourceMessageId: string;
  sourceAttachmentNames: string[];
  catalog: Catalog;
  plan: IngestionPlan;
}

const pendingTransactions = new Map<string, PendingTransaction>();
const pendingTransactionsPath = process.env.INVOICE_TEST_MODE === "true"
  ? path.resolve(".test-runtime/pending-transactions.json")
  : path.resolve("data/pending-transactions.json");

function savePendingTransactions(): void {
  writeFileSync(
    pendingTransactionsPath,
    JSON.stringify([...pendingTransactions.values()], null, 2) + "\n",
    "utf8",
  );
}

function loadPendingTransactions(): void {
  if (!existsSync(pendingTransactionsPath)) return;
  try {
    const raw = readFileSync(pendingTransactionsPath, "utf8").trim();
    if (!raw) return;
    const transactions = JSON.parse(raw) as PendingTransaction[];
    for (const transaction of transactions) {
      if (transaction?.id) pendingTransactions.set(transaction.id, transaction);
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
): PendingTransaction {
  const transaction: PendingTransaction = {
    id: randomUUID(),
    invoice,
    sourceMessageId,
    sourceAttachmentNames,
    catalog,
    plan,
  };

  pendingTransactions.set(transaction.id, transaction);
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
  return [...pendingTransactions.values()];
}

export function removePendingTransaction(id: string): void {
  if (!pendingTransactions.delete(id)) return;
  savePendingTransactions();
}

export function savePendingTransaction(transaction: PendingTransaction): void {
  pendingTransactions.set(transaction.id, transaction);
  savePendingTransactions();
}
