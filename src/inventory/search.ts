import type { V2InventoryRow } from "./types.js";

export interface InventorySearchResult<T extends V2InventoryRow = V2InventoryRow> {
  row: T;
  score: number;
}

export interface InventorySearchOptions {
  includeSoldOut?: boolean;
  limit?: number;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function searchInventory<T extends V2InventoryRow>(
  rows: T[],
  query: string,
  options: InventorySearchOptions = {},
): InventorySearchResult<T>[] {
  const normalizedQuery = normalized(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const includeSoldOut = options.includeSoldOut ?? true;
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 25);

  return rows
    .filter((row) => includeSoldOut || row.remainingQty > 0)
    .map((row) => {
      const fields = [
        row.inventoryId,
        row.skuId,
        row.cardName,
        row.setSeries,
        row.cardNumber,
        row.rarity,
        row.condition,
        row.language,
        row.variantPrinting,
        row.seller,
        row.orderId,
      ].map(normalized);
      const haystack = fields.filter(Boolean).join(" ");
      const matches = tokens.every((token) => haystack.includes(token));
      if (!matches) return { row, score: -1 };

      const name = normalized(row.cardName);
      const set = normalized(row.setSeries);
      const cardNumber = normalized(row.cardNumber);
      const inventoryId = normalized(row.inventoryId);
      const exactBoost = normalizedQuery && fields.includes(normalizedQuery) ? 1000 : 0;
      const nameBoost = normalizedQuery && name.includes(normalizedQuery) ? 500 : 0;
      const setBoost = normalizedQuery && set.includes(normalizedQuery) ? 150 : 0;
      const numberBoost = normalizedQuery && cardNumber === normalizedQuery ? 200 : 0;
      const idBoost = normalizedQuery && inventoryId === normalizedQuery ? 300 : 0;
      const stockBoost = row.remainingQty > 0 ? 10 : 0;
      return { row, score: exactBoost + nameBoost + setBoost + numberBoost + idBoost + stockBoost };
    })
    .filter((result) => result.score >= 0)
    .sort((a, b) => b.score - a.score || a.row.cardName.localeCompare(b.row.cardName) || a.row.inventoryId.localeCompare(b.row.inventoryId))
    .slice(0, limit);
}
