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
  const formatSection = (section: InventoryExportEntry[], includeQuantity: boolean) => {
    if (!section.length) return ["(none)"];

    const items = section.map((entry) => ({
      label: `${entry.cardName}${entry.cardNumber ? ` ${entry.cardNumber}` : ""}`,
      quantity: entry.remaining,
    }));

    // Fill down the left column, then the right. Pad labels and quantities
    // independently so the xN values stay vertically aligned in both columns.
    const splitAt = Math.ceil(items.length / 2);
    const left = items.slice(0, splitAt);
    const right = items.slice(splitAt);
    const leftLabelWidth = Math.max(0, ...left.map((entry) => entry.label.length));
    const rightLabelWidth = Math.max(0, ...right.map((entry) => entry.label.length));
    const formatEntry = (entry: typeof items[number], labelWidth: number) =>
      includeQuantity ? `${entry.label.padEnd(labelWidth + 2)}x${entry.quantity}` : entry.label;
    const leftWidth = includeQuantity ? leftLabelWidth + 2 + Math.max(0, ...left.map((entry) => String(entry.quantity).length)) + 1 : leftLabelWidth;
    const rowCount = Math.max(left.length, right.length);

    return Array.from({ length: rowCount }, (_, index) => {
      const leftEntry = left[index];
      const rightEntry = right[index];
      if (!rightEntry) return leftEntry ? formatEntry(leftEntry, leftLabelWidth) : "";
      const formattedLeft = formatEntry(leftEntry, leftLabelWidth);
      const formattedRight = formatEntry(rightEntry, rightLabelWidth);
      return `${formattedLeft.padEnd(leftWidth + 3)}${formattedRight}`.trimEnd();
    });
  };

  return [
    "IN STOCK",
    ...formatSection(inStock, true),
    "",
    "SOLD OUT",
    ...formatSection(sold, false),
    "",
  ].join("\n");
}
