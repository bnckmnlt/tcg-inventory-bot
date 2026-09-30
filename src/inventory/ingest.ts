import type { InvoiceData, InvoiceLineItem } from "../extract.js";
import type { Catalog, MatchState } from "../catalog/types.js";
import { resolveCardInput } from "../catalog/resolver.js";
import { normalizeInventoryVariant } from "../catalog/normalize.js";
import type { ReviewFlag, V2InventoryRow } from "./types.js";

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

type PurchaseIdentityFields = Pick<
  V2InventoryRow,
  | "orderId"
  | "sourceLine"
  | "seller"
  | "purchaseDate"
  | "cardName"
  | "setSeries"
  | "cardNumber"
  | "condition"
  | "language"
  | "variantPrinting"
  | "qtyPurchased"
  | "unitCost"
  | "totalCost"
>;

function normalizedIdentityPart(value: string | number | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Returns stable keys for the same purchased invoice line across Discord
 * reuploads. Order ID is the strongest identity; invoices without one use
 * the extracted purchase fields as a fallback.
 */
export function purchaseIdentityKeys(row: PurchaseIdentityFields): string[] {
  const sourceLine = row.sourceLine ?? 0;
  const orderId = normalizedIdentityPart(row.orderId);
  if (orderId && sourceLine > 0) {
    return ["order:" + orderId + ":line:" + sourceLine];
  }

  const base = [
    normalizedIdentityPart(row.seller),
    normalizedIdentityPart(row.purchaseDate),
    String(sourceLine),
    normalizedIdentityPart(row.cardName),
    normalizedIdentityPart(row.setSeries),
    normalizedIdentityPart(row.condition),
    normalizedIdentityPart(row.language),
    normalizedIdentityPart(row.variantPrinting),
    normalizedIdentityPart(row.qtyPurchased),
    normalizedIdentityPart(row.unitCost),
    normalizedIdentityPart(row.totalCost),
  ].join("|");

  const strict = base + "|number:" + normalizedIdentityPart(row.cardNumber);
  return ["fallback:" + strict, "fallback-relaxed:" + base];
}

const uncertainFieldFlags: Array<{ pattern: RegExp; flag: ReviewFlag }> = [
  { pattern: /image|photo|blur|confidence/i, flag: "LOW_IMAGE_CONFIDENCE" },
  { pattern: /product(name)?|card ?name/i, flag: "CARD_NAME_UNCERTAIN" },
  { pattern: /set/i, flag: "SET_UNCERTAIN" },
  { pattern: /card ?number|number/i, flag: "CARD_NUMBER_UNCERTAIN" },
  { pattern: /condition/i, flag: "CONDITION_UNCERTAIN" },
  { pattern: /variant|printing/i, flag: "VARIANT_UNCERTAIN" },
  { pattern: /quantity|qty/i, flag: "QUANTITY_UNCERTAIN" },
  { pattern: /price|cost/i, flag: "PRICE_UNCERTAIN" },
];

function reviewMetadataForLine(invoice: InvoiceData, sourceLine: number): { flags: ReviewFlag[]; notes: string[] } {
  const flags = new Set<ReviewFlag>();
  const notes: string[] = [];

  for (const uncertainty of invoice.uncertainFields) {
    const rowMatch = uncertainty.match(/(?:row|line)\s*#?\s*(\d+)/i);
    if (rowMatch && Number(rowMatch[1]) !== sourceLine) continue;

    let matched = false;
    for (const candidate of uncertainFieldFlags) {
      if (candidate.pattern.test(uncertainty)) {
        flags.add(candidate.flag);
        matched = true;
      }
    }

    if (matched || !rowMatch) notes.push(uncertainty);
  }

  return { flags: [...flags], notes };
}

function requiredText(value: string | null | undefined, fallback = ""): string {
  return value?.trim() || fallback;
}

function lineToInventoryInput(line: InvoiceLineItem, inventoryId: string, invoice: InvoiceData, sourceLine: number, review: { flags: ReviewFlag[]; notes: string[] }): V2InventoryRow {
  return {
    inventoryId,
    cardName: requiredText(line.productName),
    setSeries: requiredText(line.setName),
    cardNumber: requiredText(line.cardNumber),
    condition: requiredText(line.condition),
    language: requiredText(line.language, "English"),
    variantPrinting: normalizeInventoryVariant(line.variant),
    rarity: line.rarity ?? undefined,
    remainingQty: line.quantity ?? 0,
    qtyPurchased: line.quantity ?? undefined,
    unitCost: line.unitPrice ?? undefined,
    totalCost: line.totalPrice ?? undefined,
    purchaseDate: invoice.purchaseDate ?? undefined,
    seller: invoice.seller ?? undefined,
    orderId: invoice.orderId ?? undefined,
    sourceLine,
    reviewRequired: review.flags.length > 0,
    reviewFlags: review.flags.length > 0 ? review.flags : undefined,
    reviewNotes: review.notes.length > 0 ? review.notes : undefined,
  };
}

/**
 * Plans image/invoice records against a local catalog without writing anything.
 *
 * Every valid invoice purchase is recorded. Resolver state and SKU are enrichment
 * metadata only; they never cause a legitimate purchased line to be discarded.
 * No SKU is inferred when the resolver cannot prove an exact match.
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
    const review = reviewMetadataForLine(invoice, sourceLine);
    const input = lineToInventoryInput(line, inventoryId, invoice, sourceLine, review);

    if (!line.productName || !line.setName || (!options.allowMissingCardNumber && !line.cardNumber) || !line.quantity || line.quantity < 1) {
      rows.push({
        ingestionKey,
        sourceMessageId,
        sourceLine,
        action: "PENDING_REVIEW",
        state: "INCOMPLETE",
        input,
        reasons: ["The invoice line is missing the minimum purchase fields needed to create an inventory lot."],
      });
      return;
    }

    const purchaseKeys = purchaseIdentityKeys(input);
    if (
      existingInventoryIds.has(inventoryId) ||
      purchaseKeys.some((purchaseKey) => existingInventoryIds.has(purchaseKey))
    ) {
      input.reviewRequired = false;
      input.reviewFlags = undefined;
      input.reviewNotes = undefined;
      rows.push({
        ingestionKey,
        sourceMessageId,
        sourceLine,
        action: "SKIP",
        state: "EXACT",
        input,
        reasons: ["This invoice line is already recorded; safe retry is a no-op."],
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

    const skuId = resolved.sku?.skuId;
    input.skuId = skuId;
    input.resolutionState = resolved.state;
    input.resolutionReasons = resolved.reasons;

    // Prefer a verified catalog number over the temporary review sentinel.
    // Only replace it when the resolver proves an exact printing identity.
    if (!input.cardNumber && resolved.printing?.cardNumber) {
      input.cardNumber = resolved.printing.cardNumber;
      input.resolutionReasons = [
        ...resolved.reasons,
        "Card number inferred from the exact catalog printing: " + resolved.printing.cardNumber + ".",
      ];
    } else if (!input.cardNumber && options.allowMissingCardNumber) {
      // Workbook persistence requires a non-blank Card Number. When extraction
      // cannot provide one and the resolver cannot prove one from the catalog,
      // keep the purchase insertable with a reviewable sentinel value. This is
      // deliberately not presented as a verified card number: the review flag
      // tells the operator to replace "1" with the real number when known.
      input.cardNumber = "1";
      input.reviewRequired = true;
      input.reviewFlags = [...new Set([...(input.reviewFlags ?? []), "CARD_NUMBER_UNCERTAIN" as ReviewFlag])];
      input.reviewNotes = [
        ...(input.reviewNotes ?? []),
        'Card number was not extracted or verified; temporary value "1" was used. Replace it during review when the valid card number is known.',
      ];
    }

    rows.push({
      ingestionKey,
      sourceMessageId,
      sourceLine,
      action: "INSERT",
      state: resolved.state,
      inventoryId,
      input,
      skuId,
      reasons: skuId
        ? ["Exact catalog SKU verified; purchase record is ready to store."]
        : ["Purchase is recorded even though the catalog SKU is unresolved.", ...resolved.reasons],
    });
  });

  return {
    rows,
    insertable: rows.filter((row) => row.action === "INSERT").length,
    pendingReview: rows.filter((row) => row.action === "PENDING_REVIEW").length,
    skipped: rows.filter((row) => row.action === "SKIP").length,
  };
}
