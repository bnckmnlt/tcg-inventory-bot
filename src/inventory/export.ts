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
  const filteredRows = from && to
    ? rows.filter((row) => Boolean(row.purchaseDate && row.purchaseDate >= from && row.purchaseDate <= to))
    : rows;
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
