import type { InvoiceData, InvoiceLineItem } from "../extract.js";
import type { Catalog, MatchState } from "../catalog/types.js";
import { resolveCardInput } from "../catalog/resolver.js";
import type { V2InventoryRow } from "./types.js";

export type IngestionAction = "INSERT" | "PENDING_REVIEW" | "SKIP";

export interface IngestionPlanRow {
  ingestionKey: string;
  sourceMessageId: string;
  sourceLine: number;
  action: IngestionAction;
  state: MatchState;
  inventoryId?: string;
  input: V2InventoryRow;
  skuId?: string;
  reasons: string[];
}

export interface IngestionPlan {
  rows: IngestionPlanRow[];
  insertable: number;
  pendingReview: number;
  skipped: number;
}

function requiredText(value: string | null | undefined, fallback = ""): string {
  return value?.trim() || fallback;
}

function lineToInventoryInput(line: InvoiceLineItem, inventoryId: string, invoice: InvoiceData): V2InventoryRow {
  return {
    inventoryId,
    cardName: requiredText(line.productName),
    setSeries: requiredText(line.setName),
    cardNumber: requiredText(line.cardNumber),
    condition: requiredText(line.condition),
    language: requiredText(line.language, "English"),
    variantPrinting: requiredText(line.variant, "Normal"),
    rarity: line.rarity ?? undefined,
    remainingQty: line.quantity ?? 0,
    qtyPurchased: line.quantity ?? undefined,
    unitCost: line.unitPrice ?? undefined,
    totalCost: line.totalPrice ?? undefined,
    purchaseDate: invoice.purchaseDate ?? undefined,
    seller: invoice.seller ?? undefined,
    orderId: invoice.orderId ?? undefined,
  };
}

/**
 * Plans image/invoice records against a local catalog without writing anything.
 *
 * EXACT records are safe to insert. INCOMPLETE/AMBIGUOUS/CONFLICT/UNMATCHED
 * records are held for review. No SKU is inferred when the resolver cannot
 * prove an exact match.
 */
export function planInvoiceIngestion(
  catalog: Catalog,
  invoice: InvoiceData,
  sourceMessageId: string,
  existingInventoryIds = new Set<string>(),
  options: { allowMissingCardNumber?: boolean } = {},
): IngestionPlan {
  const rows: IngestionPlanRow[] = [];

  invoice.lineItems.forEach((line, index) => {
    const sourceLine = index + 1;
    const ingestionKey = `${sourceMessageId}:line:${sourceLine}`;
    const inventoryId = `IMG-${sourceMessageId}-${String(sourceLine).padStart(3, "0")}`;
    const input = lineToInventoryInput(line, inventoryId, invoice);

    if (!line.productName || !line.setName || (!options.allowMissingCardNumber && !line.cardNumber) || !line.condition || !line.quantity || line.quantity < 1) {
      rows.push({
        ingestionKey,
        sourceMessageId,
        sourceLine,
        action: "PENDING_REVIEW",
        state: "INCOMPLETE",
        input,
        reasons: ["Required image-parsed inventory fields are missing or invalid."],
      });
      return;
    }

    if (existingInventoryIds.has(inventoryId)) {
      rows.push({
        ingestionKey,
        sourceMessageId,
        sourceLine,
        action: "SKIP",
        state: "EXACT",
        input,
        reasons: ["This ingestion key already has an inventory ID; safe retry is a no-op."],
      });
      return;
    }

    const resolved = resolveCardInput(catalog, {
      name: input.cardName,
      setName: input.setSeries,
      cardNumber: input.cardNumber,
      language: input.language,
      variant: input.variantPrinting,
      condition: input.condition,
    }, { allowMissingCardNumber: options.allowMissingCardNumber });

    if (resolved.state === "EXACT" && resolved.sku) {
      rows.push({
        ingestionKey,
        sourceMessageId,
        sourceLine,
        action: "INSERT",
        state: "EXACT",
        inventoryId,
        input,
        skuId: resolved.sku.skuId,
        reasons: ["Exact catalog SKU verified; record is safe for local insertion."],
      });
      return;
    }

    rows.push({
      ingestionKey,
      sourceMessageId,
      sourceLine,
      action: "PENDING_REVIEW",
      state: resolved.state,
      inventoryId,
      input,
      reasons: resolved.reasons,
    });
  });

  return {
    rows,
    insertable: rows.filter((row) => row.action === "INSERT").length,
    pendingReview: rows.filter((row) => row.action === "PENDING_REVIEW").length,
    skipped: rows.filter((row) => row.action === "SKIP").length,
  };
}
