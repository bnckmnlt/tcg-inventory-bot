import type { ParsedV2InventoryRow } from "./v2-workbook.js";

export interface InventoryAvailabilitySale {
  inventoryId: string;
  dateSold?: string;
  qtySold: number;
}

export type InventoryAvailabilityStatus = "IN_STOCK" | "SOLD_OUT" | "UNDATED";

export interface InventoryAvailabilityRecord {
  row: ParsedV2InventoryRow;
  status: InventoryAvailabilityStatus;
  startDate?: string;
  endDate?: string;
  dateBasis: "PURCHASE_DATE" | "LAST_SALE_DATE" | "OPEN_START" | "OPEN_END" | "NO_DATE";
}

export interface InventoryAvailabilityResult {
  from: string;
  to: string;
  inStock: InventoryAvailabilityRecord[];
  soldOut: InventoryAvailabilityRecord[];
  undated: InventoryAvailabilityRecord[];
}

function normalizeDate(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function lastSaleDateForInventory(
  inventoryId: string,
  sales: InventoryAvailabilitySale[],
): string | undefined {
  return sales
    .filter((sale) => sale.inventoryId === inventoryId && sale.qtySold > 0)
    .map((sale) => normalizeDate(sale.dateSold))
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1);
}

/**
 * Determines whether a current inventory lot belongs in a requested date
 * range without changing the inventory or sales records.
 *
 * A purchase date is the lot's start boundary. For a sold-out lot, the latest
 * recorded sale date is its end boundary. Missing dates remain open-ended:
 * - missing purchase date => open start;
 * - sold-out with no sale date => open end;
 * - missing both => undated fallback.
 *
 * The command reports current stock state, not a historical quantity snapshot.
 */
export function findInventoryAvailability(
  rows: ParsedV2InventoryRow[],
  sales: InventoryAvailabilitySale[],
  from: string,
  to: string,
): InventoryAvailabilityResult {
  const result: InventoryAvailabilityResult = { from, to, inStock: [], soldOut: [], undated: [] };

  for (const row of rows) {
    const purchaseDate = normalizeDate(row.purchaseDate);
    const lastSaleDate = lastSaleDateForInventory(row.inventoryId, sales);

    // A purchase date establishes when the lot could first be available.
    // Only a lot that is actually sold out can use its latest sale date as the
    // end boundary. Partial sales do not turn a stock lot into SOLD OUT.
    if (purchaseDate && purchaseDate > to) continue;

    if (row.remainingQty > 0) {
      if (purchaseDate) {
        result.inStock.push({
          row,
          status: "IN_STOCK",
          startDate: purchaseDate,
          dateBasis: "PURCHASE_DATE",
        });
      } else {
        result.undated.push({
          row,
          status: "UNDATED",
          dateBasis: "NO_DATE",
        });
      }
      continue;
    }

    if (lastSaleDate) {
      if (lastSaleDate < from) continue;

      if (lastSaleDate <= to) {
        result.soldOut.push({
          row,
          status: "SOLD_OUT",
          startDate: purchaseDate,
          endDate: lastSaleDate,
          dateBasis: purchaseDate ? "PURCHASE_DATE" : "LAST_SALE_DATE",
        });
      } else {
        result.inStock.push({
          row,
          status: "IN_STOCK",
          startDate: purchaseDate,
          endDate: lastSaleDate,
          dateBasis: purchaseDate ? "PURCHASE_DATE" : "LAST_SALE_DATE",
        });
      }
      continue;
    }

    // No recorded sale date means a sold-out lot has no reliable end boundary.
    // Keep it visible without guessing when the sold-out state applied.
    result.undated.push({
      row,
      status: "UNDATED",
      startDate: purchaseDate,
      endDate: undefined,
      dateBasis: purchaseDate ? "OPEN_END" : "NO_DATE",
    });
  }

  const sortRecords = (records: InventoryAvailabilityRecord[]) => records.sort((a, b) =>
    a.row.cardName.localeCompare(b.row.cardName) ||
    a.row.setSeries.localeCompare(b.row.setSeries) ||
    a.row.inventoryId.localeCompare(b.row.inventoryId),
  );

  sortRecords(result.inStock);
  sortRecords(result.soldOut);
  sortRecords(result.undated);
  return result;
}
