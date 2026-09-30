import "dotenv/config";
import path from "node:path";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { readGoogleSheetInventoryIds } from "./google-sheets.js";

const workbookPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.INVENTORY_WORKBOOK_PATH
    ? path.resolve(process.env.INVENTORY_WORKBOOK_PATH)
    : undefined;

if (!workbookPath) {
  throw new Error("Usage: npm run inventory:verify -- <path-to-v2-xlsx>");
}

const marker = process.argv[3] ?? "";
const parsed = readV2InventoryWorkbook(workbookPath);
if (parsed.issues.length > 0) {
  throw new Error(`Workbook parser issues: ${parsed.issues.map((issue) => issue.message).join(" | ")}`);
}

const validInventoryId = (value: string) => /^(?:INV-\d+|IMG-DISCORD-\d+-\d+-\d+)$/.test(value);
const workbookInventoryRows = parsed.rows.filter((row) => validInventoryId(row.inventoryId));
const workbookIds = new Set(workbookInventoryRows.map((row) => row.inventoryId));
const duplicates = workbookInventoryRows
  .map((row) => row.inventoryId)
  .filter((id, index, all) => all.indexOf(id) !== index);

const localMarkerRows = marker
  ? workbookInventoryRows.filter((row) => row.inventoryId.includes(marker))
  : [];

const sheetIds = await readGoogleSheetInventoryIds();
const workbookMissingFromSheets = [...workbookIds].filter((id) => !sheetIds.has(id));
const sheetMissingFromWorkbook = [...sheetIds].filter((id) => !workbookIds.has(id));

console.log(JSON.stringify({
  workbook: workbookPath,
  workbookRows: parsed.rows.length,
  workbookInventoryRows: workbookInventoryRows.length,
  workbookUniqueIds: workbookIds.size,
  workbookDuplicateIds: [...new Set(duplicates)],
  googleSheetRowsByInventoryId: sheetIds.size,
  workbookMissingFromGoogleSheets: workbookMissingFromSheets.length,
  workbookMissingInventoryIds: workbookMissingFromSheets,
  googleSheetMissingFromWorkbook: sheetMissingFromWorkbook.length,
  googleSheetOnlyInventoryIds: sheetMissingFromWorkbook,
  marker,
  markerMatches: localMarkerRows.length,
  markerInventoryIds: localMarkerRows.map((row) => row.inventoryId),
  ok: duplicates.length === 0 && workbookMissingFromSheets.length === 0 && sheetMissingFromWorkbook.length === 0,
}, null, 2));
