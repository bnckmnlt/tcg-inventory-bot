import type { ParsedV2InventoryRow } from "./v2-workbook.js";

export interface InventoryExportEntry {
  cardName: string;
  cardNumber: string;
  purchased: number;
  remaining: number;
}

export function buildInventoryExport(rows: ParsedV2InventoryRow[]): InventoryExportEntry[] {
  const grouped = new Map<string, InventoryExportEntry>();
  for (const row of rows) {
    if (!row.cardName.trim() || row.qtyPurchased <= 0) continue;
    const cardName = row.cardName.trim();
    const cardNumber = row.cardNumber.trim();
    const key = [cardName, cardNumber].map((value) => value.toLocaleLowerCase()).join("|");
    const entry = grouped.get(key) ?? { cardName, cardNumber, purchased: 0, remaining: 0 };
    entry.purchased += row.qtyPurchased;
    entry.remaining += Math.max(0, row.remainingQty);
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort((a, b) =>
    a.cardName.localeCompare(b.cardName) || a.cardNumber.localeCompare(b.cardNumber)
  );
}

export function formatInventoryExport(
  rows: ParsedV2InventoryRow[],
  from?: string,
  to?: string,
): string {
  let filteredRows = rows;
  if (from && to) {
    // Match inventory-availability's date-gap handling: blank purchase dates
    // are included only when the row sits between two dated rows whose
    // interval overlaps the requested range. Leading/trailing undated rows
    // remain excluded, rather than being assigned a guessed date.
    const previousDatedRow: Array<string | undefined> = [];
    const nextDatedRow: Array<string | undefined> = [];
    let previousDate: string | undefined;
    for (let index = 0; index < rows.length; index += 1) {
      previousDatedRow[index] = previousDate;
      const date = rows[index].purchaseDate?.trim();
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) previousDate = date;
    }

    let nextDate: string | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      nextDatedRow[index] = nextDate;
      const date = rows[index].purchaseDate?.trim();
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) nextDate = date;
    }

    filteredRows = rows.filter((row, index) => {
      const date = row.purchaseDate?.trim();
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date >= from && date <= to;
      }
      const start = previousDatedRow[index];
      const end = nextDatedRow[index];
      return Boolean(start && end && start <= to && end >= from);
    });
  }
  const entries = buildInventoryExport(filteredRows);
  const inStock = entries.filter((entry) => entry.remaining > 0);
  const sold = entries.filter((entry) => entry.remaining === 0 && entry.purchased > 0);
  const formatSection = (section: InventoryExportEntry[]) => {
    if (!section.length) return ["(none)"];
    const labels = section.map((entry) =>
      `${entry.cardName}${entry.cardNumber ? ` ${entry.cardNumber}` : ""}`
    );
    const stockColumn = Math.max(...labels.map((label) => label.length)) + 3;
    return section.map((entry, index) =>
      section === sold
        ? labels[index]
        : `${labels[index].padEnd(stockColumn)}x${entry.remaining}`
    );
  };

  return [
    "IN STOCK",
    ...formatSection(inStock),
    "",
    "SOLD OUT",
    ...formatSection(sold),
    "",
  ].join("\n");
}
