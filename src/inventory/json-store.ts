import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { V2InventoryRow } from "./types.js";
import type { IngestionPlanRow } from "./ingest.js";
import { applyInsertionPlan, type AppliedIngestion, type LocalInventoryStore } from "./local-store.js";

export class JsonInventoryStore implements LocalInventoryStore {
  private readonly rowsById = new Map<string, V2InventoryRow>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const rows = JSON.parse(raw) as V2InventoryRow[];
      for (const row of rows) this.insert(row);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

  async save(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.list(), null, 2) + "\n", "utf8");
  }

  async apply(planRows: IngestionPlanRow[]): Promise<AppliedIngestion> {
    const result = applyInsertionPlan(this, planRows);
    if (result.inserted > 0) await this.save();
    return result;
  }
}

export async function createJsonInventoryStore(filePath = path.resolve("data/inventory.json")): Promise<JsonInventoryStore> {
  const store = new JsonInventoryStore(filePath);
  await store.load();
  return store;
}
