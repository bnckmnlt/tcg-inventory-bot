import "dotenv/config";
import path from "node:path";
import {
  createInventoryBackup,
  listInventoryBackups,
  restoreInventoryBackup,
} from "./backup.js";

const workbookPath = process.env.INVENTORY_WORKBOOK_PATH
  ? path.resolve(process.env.INVENTORY_WORKBOOK_PATH)
  : undefined;
const inventoryPath = path.resolve("data/inventory.json");

const command = process.argv[2];

if (command === "list") {
  const backups = await listInventoryBackups({ workbookPath, inventoryPath });
  console.log(JSON.stringify(backups, null, 2));
  process.exit(0);
}

if (command === "create") {
  const result = await createInventoryBackup({ workbookPath, inventoryPath });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "restore") {
  const backupPath = process.argv[3];
  if (!backupPath) {
    throw new Error("Usage: npm run inventory:backup -- restore <backup-file>");
  }

  const result = await restoreInventoryBackup(backupPath, {
    workbookPath,
    inventoryPath,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

throw new Error(
  "Usage: npm run inventory:backup -- <create|list|restore <backup-file>>",
);
