import { randomUUID } from "node:crypto";
import type { InvoiceData } from "./extract.js";
import type { IngestionPlan } from "./inventory/ingest.js";
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
  return transaction;
}

export function getPendingTransaction(id: string): PendingTransaction | undefined {
  return pendingTransactions.get(id);
}

export function removePendingTransaction(id: string): void {
  pendingTransactions.delete(id);
}
