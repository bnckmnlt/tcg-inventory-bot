import type { V2InventoryRow } from "./types.js";

export const V2_INVENTORY_HEADERS = [
  "Inventory ID",
  "Card Key",
  "Card Name",
  "Set / Series",
  "Card Number",
  "Rarity",
  "Condition",
  "Language",
  "Variant / Printing",
  "Purchase Date",
  "Seller",
  "Order ID",
  "Qty Purchased",
  "Unit Cost (₱ each)",
  "Total Cost (₱)",
  "Expected Sell Price (₱)",
  "Avg. Actual Sell Price (₱)",
  "Qty Sold",
  "Remaining Qty",
  "Total Revenue (₱)",
  "Cost Sold (FIFO)",
  "Realized Profit / Loss (₱)",
  "Stock Status",
  "Status Override",
  "Notes",
] as const;

export interface ParsedV2InventoryRow extends V2InventoryRow {
  sourceRow: number;
  rawCardKey: string;
  qtyPurchased: number;
  unitCost: number;
  raw: Record<string, unknown>;
}

export interface V2WorkbookParseIssue {
  sourceRow: number;
  field?: string;
  message: string;
}

export interface V2WorkbookParseResult {
  rows: ParsedV2InventoryRow[];
  issues: V2WorkbookParseIssue[];
}

export function buildInventoryCardKey(row: Pick<ParsedV2InventoryRow, "cardName" | "setSeries" | "cardNumber" | "rarity" | "condition" | "language" | "variantPrinting">): string {
  return [row.cardName, row.setSeries, row.cardNumber, row.rarity || "", row.condition, row.language, row.variantPrinting || "Normal"]
    .map((value) => String(value || "").trim())
    .join("|")
    .toUpperCase();
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = text(value).replace(/[,₱]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headerIndex(headers: unknown[]): Map<string, number> {
  return new Map(Array.from({ length: headers.length }, (_, index) => [text(headers[index]).toLowerCase(), index] as const));
}

function valueAt(row: unknown[], indexes: Map<string, number>, header: string): unknown {
  const index = indexes.get(header.toLowerCase());
  return index == null ? undefined : row[index];
}

/**
 * Parses the Inventory worksheet's tabular values without depending on an
 * XLSX library. An XLSX reader can feed its worksheet rows directly here.
 *
 * The parser deliberately keeps the legacy Card Key and raw row values for
 * audit/debugging, but the resolver must use the structured identity fields.
 */
export function parseV2InventorySheet(sheetRows: unknown[][]): V2WorkbookParseResult {
  if (sheetRows.length === 0) {
    return { rows: [], issues: [{ sourceRow: 1, message: "Inventory sheet is empty." }] };
  }

  const headerRowIndex = sheetRows.findIndex((row) => {
    const indexes = headerIndex(row);
    return V2_INVENTORY_HEADERS.every((header) => indexes.has(header.toLowerCase()));
  });
  const issues: V2WorkbookParseIssue[] = [];

  if (headerRowIndex < 0) {
    return {
      rows: [],
      issues: [{ sourceRow: 1, message: `Missing V2 Inventory headers: ${V2_INVENTORY_HEADERS.join(", ")}.` }],
    };
  }

  const indexes = headerIndex(sheetRows[headerRowIndex]);
  const rows: ParsedV2InventoryRow[] = [];

  sheetRows.slice(headerRowIndex + 1).forEach((raw, offset) => {
    const sourceRow = headerRowIndex + offset + 2;
    const inventoryId = text(valueAt(raw, indexes, "Inventory ID"));
    if (!inventoryId) return;

    const cardName = text(valueAt(raw, indexes, "Card Name"));
    const setSeries = text(valueAt(raw, indexes, "Set / Series"));
    const cardNumber = text(valueAt(raw, indexes, "Card Number"));
    const condition = text(valueAt(raw, indexes, "Condition"));
    const language = text(valueAt(raw, indexes, "Language"));
    const variantPrinting = text(valueAt(raw, indexes, "Variant / Printing")) || "Normal";
    const qtyPurchased = number(valueAt(raw, indexes, "Qty Purchased"));
    const unitCost = number(valueAt(raw, indexes, "Unit Cost (₱ each)"));
    const qtySold = number(valueAt(raw, indexes, "Qty Sold")) ?? 0;
    const remainingValue = valueAt(raw, indexes, "Remaining Qty");
    // Google Sheets can return an empty formatted value for a formula cell while
    // the source quantities are still present. Derive Remaining Qty in that case.
    const remainingQty = number(remainingValue) ?? (
      qtyPurchased != null && qtySold != null ? Math.max(0, qtyPurchased - qtySold) : undefined
    );

    const required: Array<[string, string, unknown]> = [
      ["Card Name", "cardName", cardName],
      ["Set / Series", "setSeries", setSeries],
      ["Card Number", "cardNumber", cardNumber],
      ["Condition", "condition", condition],
      ["Language", "language", language],
    ];

    for (const [field, key, value] of required) {
      if (!value) issues.push({ sourceRow, field: key, message: `${field} is blank.` });
    }
    if (qtyPurchased == null) issues.push({ sourceRow, field: "qtyPurchased", message: "Qty Purchased is not numeric." });
    if (unitCost == null) issues.push({ sourceRow, field: "unitCost", message: "Unit Cost is not numeric." });
    if (remainingQty == null) issues.push({ sourceRow, field: "remainingQty", message: "Remaining Qty is not numeric." });

    if (qtyPurchased == null || unitCost == null || remainingQty == null) return;

    const rawRecord: Record<string, unknown> = {};
    for (const [header, index] of indexes) rawRecord[header] = raw[index];

    rows.push({
      sourceRow,
      inventoryId,
      rawCardKey: text(valueAt(raw, indexes, "Card Key")),
      cardName,
      setSeries,
      cardNumber,
      rarity: text(valueAt(raw, indexes, "Rarity")) || undefined,
      condition,
      language,
      variantPrinting,
      remainingQty,
      qtyPurchased,
      unitCost,
      raw: rawRecord,
    });
  });

  return { rows, issues };
}

export function toResolverInventoryRows(rows: ParsedV2InventoryRow[]): V2InventoryRow[] {
  return rows.map(({ sourceRow: _sourceRow, rawCardKey: _rawCardKey, qtyPurchased: _qtyPurchased, unitCost: _unitCost, raw: _raw, ...row }) => row);
}
