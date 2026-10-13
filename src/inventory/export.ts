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

export function formatInventoryExport(rows: ParsedV2InventoryRow[]): string {
  const entries = buildInventoryExport(rows);
  const inStock = entries.filter((entry) => entry.remaining > 0);
  const sold = entries.filter((entry) => entry.remaining === 0 && entry.purchased > 0);
  const formatEntry = (entry: InventoryExportEntry) =>
    `x${entry.remaining} ${entry.cardName}${entry.cardNumber ? ` ${entry.cardNumber}` : ""}`;

  return [
    "IN STOCK",
    ...(inStock.length ? inStock.map(formatEntry) : ["(none)"]),
    "",
    "SOLD OUT",
    ...(sold.length ? sold.map(formatEntry) : ["(none)"]),
    "",
  ].join("\n");
}
