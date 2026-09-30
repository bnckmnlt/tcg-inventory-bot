import "dotenv/config";
import path from "node:path";
import { syncWorkbookInventoryToGoogleSheets } from "./google-sheets.js";

const workbookPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.INVENTORY_WORKBOOK_PATH
    ? path.resolve(process.env.INVENTORY_WORKBOOK_PATH)
    : undefined;

if (!workbookPath) {
  throw new Error("Usage: npm run inventory:sheets:sync -- <path-to-v2-xlsx>");
}

const result = await syncWorkbookInventoryToGoogleSheets(workbookPath);
console.log(JSON.stringify({
  workbook: workbookPath,
  inserted: result.inserted,
  skipped: result.skipped,
}, null, 2));
