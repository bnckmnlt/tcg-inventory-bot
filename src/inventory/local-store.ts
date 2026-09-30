import type { IngestionPlanRow } from "./ingest.js";
import type { V2InventoryRow } from "./types.js";

export interface LocalInventoryStore {
  list(): V2InventoryRow[];
  hasInventoryId(inventoryId: string): boolean;
  insert(row: V2InventoryRow): void;
}

export class InMemoryInventoryStore implements LocalInventoryStore {
  private readonly rowsById = new Map<string, V2InventoryRow>();

  constructor(initialRows: V2InventoryRow[] = []) {
    for (const row of initialRows) this.insert(row);
  }

  list(): V2InventoryRow[] {
    return [...this.rowsById.values()];
  }

  hasInventoryId(inventoryId: string): boolean {
    return this.rowsById.has(inventoryId);
  }

  insert(row: V2InventoryRow): void {
    if (this.rowsById.has(row.inventoryId)) {
      throw new Error(`Inventory ID already exists: ${row.inventoryId}`);
    }
    this.rowsById.set(row.inventoryId, { ...row });
  }
}

export interface AppliedIngestion {
  inserted: number;
  skipped: number;
  pendingReview: number;
}

export function applyInsertionPlan(
  store: LocalInventoryStore,
  rows: IngestionPlanRow[],
): AppliedIngestion {
  let inserted = 0;
  let skipped = 0;
  let pendingReview = 0;

  for (const row of rows) {
    if (row.action === "INSERT") {
      if (store.hasInventoryId(row.inventoryId!)) {
        skipped += 1;
        continue;
      }
      store.insert(row.input);
      inserted += 1;
    } else if (row.action === "SKIP") {
      skipped += 1;
    } else {
      pendingReview += 1;
    }
  }

  return { inserted, skipped, pendingReview };
}
