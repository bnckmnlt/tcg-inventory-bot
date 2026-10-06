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
  dateBasis: "PURCHASE_DATE" | "LAST_SALE_DATE" | "ROW_RANGE" | "OPEN_START" | "OPEN_END" | "NO_DATE";
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

  // Some inventory imports have a date on the first row of a group and then
  // blank dates until the next dated row. Treat those blank rows as belonging
  // to the interval between the nearest dated rows. This deliberately does
  // not extend beyond the last dated row, so trailing undated records are not
  // pulled into a date-range query.
  const previousDatedRow: Array<string | undefined> = [];
  const nextDatedRow: Array<string | undefined> = [];
  let previousDate: string | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    previousDatedRow[index] = previousDate;
    const date = normalizeDate(rows[index].purchaseDate);
    if (date) previousDate = date;
  }
  let nextDate: string | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    nextDatedRow[index] = nextDate;
    const date = normalizeDate(rows[index].purchaseDate);
    if (date) nextDate = date;
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const purchaseDate = normalizeDate(row.purchaseDate);
    const lastSaleDate = lastSaleDateForInventory(row.inventoryId, sales);
    const surroundingStart = previousDatedRow[index];
    const surroundingEnd = nextDatedRow[index];
    const rowRangeAvailable = !purchaseDate && Boolean(surroundingStart && surroundingEnd);

    // A purchase date establishes when the lot could first be available.
    // Only a lot that is actually sold out can use its latest sale date as the
    // end boundary. Partial sales do not turn a stock lot into SOLD OUT.
    if (purchaseDate && purchaseDate > to) continue;
    if (!purchaseDate && !rowRangeAvailable && !lastSaleDate) {
      result.undated.push({
        row,
        status: "UNDATED",
        dateBasis: "NO_DATE",
      });
      continue;
    }

    if (row.remainingQty > 0) {
      if (purchaseDate) {
        result.inStock.push({
          row,
          status: "IN_STOCK",
          startDate: purchaseDate,
          dateBasis: "PURCHASE_DATE",
        });
      } else if (surroundingStart && surroundingEnd && surroundingStart <= to && surroundingEnd >= from) {
        result.inStock.push({
          row,
          status: "IN_STOCK",
          startDate: surroundingStart,
          endDate: surroundingEnd,
          dateBasis: "ROW_RANGE",
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

    // A blank-date sold-out row can use its surrounding dated row interval,
    // but only when it is actually between two dated rows. A trailing blank
    // section remains undated rather than being assigned a guessed date.
    if (!purchaseDate && surroundingStart && surroundingEnd && surroundingStart <= to && surroundingEnd >= from) {
      result.soldOut.push({
        row,
        status: "SOLD_OUT",
        startDate: surroundingStart,
        endDate: surroundingEnd,
        dateBasis: "ROW_RANGE",
      });
      continue;
    }

    // No recorded sale date means a sold-out lot has no reliable end boundary.
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
