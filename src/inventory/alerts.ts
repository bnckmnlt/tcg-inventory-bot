import type { V2InventoryRow } from "./types.js";

export type InventoryAlertType = "SOLD_OUT" | "LOW_STOCK";

export interface InventoryAlert<T extends V2InventoryRow = V2InventoryRow> {
  type: InventoryAlertType;
  row: T;
  severity: "critical" | "warning";
}

export interface InventoryAlertOptions {
  lowStockThreshold?: number;
  limit?: number;
}

export function getInventoryAlerts<T extends V2InventoryRow>(
  rows: T[],
  options: InventoryAlertOptions = {},
): InventoryAlert<T>[] {
  const lowStockThreshold = Math.max(1, Math.floor(options.lowStockThreshold ?? 2));
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  return rows
    .flatMap((row): InventoryAlert<T>[] => {
      if (row.remainingQty <= 0) {
        return [{ type: "SOLD_OUT", row, severity: "critical" }];
      }
      if (row.remainingQty <= lowStockThreshold) {
        return [{ type: "LOW_STOCK", row, severity: "warning" }];
      }
      return [];
    })
    .sort((a, b) =>
      (a.type === "SOLD_OUT" ? 0 : 1) - (b.type === "SOLD_OUT" ? 0 : 1) ||
      a.row.remainingQty - b.row.remainingQty ||
      a.row.cardName.localeCompare(b.row.cardName) ||
      a.row.inventoryId.localeCompare(b.row.inventoryId),
    )
    .slice(0, limit);
}

export function countInventoryAlerts<T extends V2InventoryRow>(
  rows: T[],
  lowStockThreshold = 2,
): { soldOut: number; lowStock: number; total: number } {
  const threshold = Math.max(1, Math.floor(lowStockThreshold));
  let soldOut = 0;
  let lowStock = 0;

  for (const row of rows) {
    if (row.remainingQty <= 0) soldOut++;
    else if (row.remainingQty <= threshold) lowStock++;
  }

  return { soldOut, lowStock, total: soldOut + lowStock };
}
