import { buildInventoryCardKey, parseV2InventorySheet, type ParsedV2InventoryRow } from "./v2-workbook.js";
import { readGoogleSheetInventoryRows } from "./google-sheets.js";

export interface SaleDraft {
  cardKey: string;
  inventoryId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  condition: string;
  language: string;
  variantPrinting: string;
  dateSold: string;
  qtySold: number;
  sellPrice: number;
  notes?: string;
}

export interface SaleAllocation {
  inventoryId: string;
  qty: number;
  unitCost: number;
}

export interface SalePlan {
  saleId: string;
  allocations: SaleAllocation[];
}

export function searchInventoryRows(rows: ParsedV2InventoryRow[], query: string): ParsedV2InventoryRow[] {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return rows
    .filter(function (row) { return row.remainingQty > 0; })
    .map(function (row) {
      const haystack = [row.inventoryId, row.rawCardKey, row.cardName, row.setSeries, row.cardNumber, row.rarity, row.condition, row.language, row.variantPrinting]
        .filter(Boolean).join(" ").toLowerCase();
      const matches = tokens.every(function (token) { return haystack.includes(token); });
      const exactBoost = normalized && haystack.includes(normalized) ? 100 : 0;
      const nameBoost = normalized && row.cardName.toLowerCase().includes(normalized) ? 50 : 0;
      return { row: row, matches: matches, score: exactBoost + nameBoost };
    })
    .filter(function (candidate) { return candidate.matches; })
    .sort(function (a, b) { return b.score - a.score || a.row.cardName.localeCompare(b.row.cardName); })
    .slice(0, 25)
    .map(function (candidate) { return candidate.row; });
}

export function buildSelectedLotSalePlan(rows: ParsedV2InventoryRow[], draft: SaleDraft, existingSaleIds: string[]): SalePlan {
  const selected = rows.find(function (row) {
    return row.inventoryId === draft.inventoryId && buildInventoryCardKey(row) === draft.cardKey && row.remainingQty > 0;
  });

  if (!selected) {
    throw new Error("The selected inventory record is no longer available for this card. Search again.");
  }
  if (!Number.isInteger(draft.qtySold) || draft.qtySold < 1) throw new Error("Quantity must be a positive integer.");
  if (!Number.isFinite(draft.sellPrice) || draft.sellPrice < 0) throw new Error("Sell price must be a non-negative number.");

  if (draft.qtySold > selected.remainingQty) {
    throw new Error("Only " + selected.remainingQty + " unit(s) remain in the selected inventory lot.");
  }

  // A sale is tied to the exact inventory lot selected in Discord. Do not spill
  // excess quantity into another lot, even if the card name is identical.
  const lots = rows
    .filter((row) => row.inventoryId === selected.inventoryId)
    .sort((a, b) => {
      if (!a.purchaseDate && b.purchaseDate) return -1;
      if (a.purchaseDate && !b.purchaseDate) return 1;
      if (a.purchaseDate && b.purchaseDate && a.purchaseDate !== b.purchaseDate) {
        return a.purchaseDate.localeCompare(b.purchaseDate);
      }
      return a.inventoryId.localeCompare(b.inventoryId);
    });
  let remaining = draft.qtySold;
  const allocations: SaleAllocation[] = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, lot.remainingQty);
    allocations.push({ inventoryId: lot.inventoryId, qty, unitCost: lot.unitCost });
    remaining -= qty;
  }

  let maxSale = 0;
  for (const id of existingSaleIds) {
    const match = id.match(/^SALE-(\d+)$/i);
    if (match) maxSale = Math.max(maxSale, Number(match[1]));
  }
  const saleId = "SALE-" + String(maxSale + 1).padStart(6, "0");

  return { saleId, allocations };
}

export async function loadSaleInventory(useGoogleSheets: boolean, workbookRows?: ParsedV2InventoryRow[]): Promise<ParsedV2InventoryRow[]> {
  if (useGoogleSheets) return readGoogleSheetInventoryRows();
  return workbookRows || [];
}

export function excelSerialToIso(value: unknown): string | undefined {
  const serial = typeof value === "number" ? value : Number(String(value || ""));
  if (!Number.isFinite(serial)) return undefined;
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

export function parseSaleSheetValues(values: unknown[][]): { saleIds: string[]; firstEmptyRow: number } {
  const saleIds = values.slice(1).map(function (row) { return String(row[0] || "").trim(); }).filter(Boolean);
  const emptyIndex = values.findIndex(function (row, index) { return index > 0 && !String(row[0] || "").trim(); });
  return { saleIds: saleIds, firstEmptyRow: emptyIndex >= 0 ? emptyIndex + 3 : 5001 };
}

export function parseAllocationSheetValues(values: unknown[][]): { allocationIds: string[]; firstEmptyRow: number } {
  const allocationIds = values.slice(1).map(function (row) { return String(row[0] || "").trim(); }).filter(Boolean);
  const emptyIndex = values.findIndex(function (row, index) { return index > 0 && !String(row[0] || "").trim(); });
  return { allocationIds: allocationIds, firstEmptyRow: emptyIndex >= 0 ? emptyIndex + 3 : 5001 };
}

export function nextAllocationNumber(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/^ALLOC-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function buildSaleCardKey(draft: SaleDraft): string {
  return buildInventoryCardKey(draft);
}
