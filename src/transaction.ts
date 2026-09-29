import { randomUUID } from "node:crypto";
import type { InvoiceData } from "./extract.js";

export interface PendingTransaction {
  id: string;
  invoice: InvoiceData;
  sourceMessageId: string;
  sourceAttachmentNames: string[];
}

const pendingTransactions = new Map<string, PendingTransaction>();

export function createPendingTransaction(
  invoice: InvoiceData,
  sourceMessageId: string,
  sourceAttachmentNames: string[],
): PendingTransaction {
  const transaction: PendingTransaction = {
    id: randomUUID(),
    invoice,
    sourceMessageId,
    sourceAttachmentNames,
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
