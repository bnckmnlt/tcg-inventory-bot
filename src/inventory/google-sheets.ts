import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { parseV2InventorySheet, V2_INVENTORY_HEADERS, type ParsedV2InventoryRow } from "./v2-workbook.js";
import type { V2InventoryRow } from "./types.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  credentials: GoogleServiceAccount;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function loadConfig(): SheetsConfig {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME?.trim() || "Inventory";
  if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is missing.");

  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const credentialsPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH?.trim();

  if (!rawJson && !credentialsPath) {
    throw new Error(
      "Google Sheets credentials are missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_PATH.",
    );
  }

  const raw = rawJson
    ? rawJson
    : existsSync(credentialsPath!)
      ? readFileSync(credentialsPath!, "utf8")
      : "";

  const credentials = JSON.parse(raw) as GoogleServiceAccount;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account JSON must contain client_email and private_key.");
  }

  return { spreadsheetId, sheetName, credentials };
}

async function getAccessToken(credentials: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: SHEETS_SCOPE,
      aud: credentials.token_uri || "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = header + "." + payload;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = unsigned + "." + signer.sign(credentials.private_key).toString("base64url");

  const response = await fetch(credentials.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google OAuth token response did not include access_token.");
  return body.access_token;
}

async function sheetsRequest<T>(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API request failed: ${response.status} ${await response.text()}`);
  }

  return await response.json() as T;
}

async function verifySheetName(token: string, spreadsheetId: string, configuredSheetName: string): Promise<string> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`;
  const body = await sheetsRequest(token, url);
  const sheets = ((body as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }).sheets ?? []);
  const match = sheets.find((sheet) => sheet.properties?.title === configuredSheetName);
  if (match?.properties?.title) return match.properties.title;
  throw new Error(`Google Sheet tab "${configuredSheetName}" was not found. Available tabs: ${sheets.map((sheet) => sheet.properties?.title).filter(Boolean).join(", ") || "none"}`);
}

async function backupGoogleSheetTab(token: string, spreadsheetId: string, sheetName: string): Promise<string> {
  const metadataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`;
  const metadata = await sheetsRequest<{ sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }>(token, metadataUrl);
  const source = (metadata.sheets ?? []).find((sheet) => sheet.properties?.title === sheetName);
  const sourceId = source?.properties?.sheetId;
  if (sourceId === undefined) throw new Error(`Cannot back up Google Sheet tab "${sheetName}" because its tab ID was not found.`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupTitle = `Backup ${sheetName} ${timestamp}`.slice(0, 100);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  await sheetsRequest(token, url, {
    method: "POST",
    body: JSON.stringify({ requests: [{ duplicateSheet: { sourceSheetId: sourceId, newSheetName: backupTitle } }] }),
  });
  return backupTitle;
}


function rawValue(row: ParsedV2InventoryRow, header: string): unknown {
  return row.raw[header] ?? row.raw[header.toLowerCase()] ?? "";
}

function rowValues(row: ParsedV2InventoryRow): unknown[] {
  return V2_INVENTORY_HEADERS.map((header) => {
    const value = rawValue(row, header);
    if (value == null) return "";
    return typeof value === "number" || typeof value === "boolean" ? value : String(value);
  });
}

function range(sheetName: string, a1: string): string {
  // Quote sheet names so spaces and other special characters are valid in A1 notation.
  return encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'!${a1}`);
}

function quotedSheetRange(sheetName: string, a1: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${a1}`;
}

async function ensureHeaderRow(token: string, spreadsheetId: string, sheetName: string): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range(sheetName, "A1:Y1")}?valueInputOption=USER_ENTERED`;
  await sheetsRequest(token, url, {
    method: "PUT",
    body: JSON.stringify({ range: quotedSheetRange(sheetName, "A1:Y1"), majorDimension: "ROWS", values: [V2_INVENTORY_HEADERS] }),
  });
}

export async function readGoogleSheetInventoryIds(): Promise<Set<string>> {
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const sheetName = await verifySheetName(token, config.spreadsheetId, config.sheetName);
  const ids = await existingInventoryIds(token, config.spreadsheetId, sheetName);
  return new Set([...ids].filter((id) => /^(?:INV-\d+|IMG-DISCORD-\d+-\d+-\d+)$/.test(id)));
}

async function existingInventoryIds(token: string, spreadsheetId: string, sheetName: string): Promise<Set<string>> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range(sheetName, "A2:A")}`;
  const body = await sheetsRequest<{ values?: unknown[][] }>(token, url);
  return new Set(
    (body.values ?? [])
      .map((row) => String(row[0] ?? "").trim())
      .filter(Boolean),
  );
}

async function appendRows(
  token: string,
  spreadsheetId: string,
  sheetName: string,
  rows: ParsedV2InventoryRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range(sheetName, "A:Y")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await sheetsRequest(token, url, {
    method: "POST",
    body: JSON.stringify({
      majorDimension: "ROWS",
      values: rows.map(rowValues),
    }),
  });
  return rows.length;
}

export async function syncWorkbookInventoryToGoogleSheets(workbookPath: string): Promise<{ inserted: number; skipped: number }> {
  if (!existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);

  const parsed = readV2InventoryWorkbook(workbookPath);
  if (parsed.issues.length > 0) {
    throw new Error(`Workbook has parser issues; refusing to sync: ${parsed.issues.map((issue) => issue.message).join(" | ")}`);
  }

  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const sheetName = await verifySheetName(token, config.spreadsheetId, config.sheetName);

  const existing = await existingInventoryIds(token, config.spreadsheetId, sheetName);
  const pending = parsed.rows.filter((row) => !existing.has(row.inventoryId));
  if (pending.length > 0 && process.env.GOOGLE_SHEETS_BACKUP_ON_WRITE === "true") {
    await backupGoogleSheetTab(token, config.spreadsheetId, sheetName);
  }
  await ensureHeaderRow(token, config.spreadsheetId, sheetName);
  const inserted = await appendRows(token, config.spreadsheetId, sheetName, pending);

  return { inserted, skipped: parsed.rows.length - inserted };
}

export async function appendInventoryRowsToGoogleSheets(
  workbookPath: string,
  inventoryIds: string[],
): Promise<{ inserted: number; skipped: number }> {
  if (!existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);
  if (inventoryIds.length === 0) return { inserted: 0, skipped: 0 };

  const parsed = readV2InventoryWorkbook(workbookPath);
  if (parsed.issues.length > 0) {
    throw new Error(`Workbook has parser issues; refusing to sync: ${parsed.issues.map((issue) => issue.message).join(" | ")}`);
  }

  return appendParsedInventoryRowsToGoogleSheets(parsed.rows.filter((row) => new Set(inventoryIds).has(row.inventoryId)));
}

function inventoryRowToParsed(row: V2InventoryRow): ParsedV2InventoryRow {
  const raw: Record<string, unknown> = {
    "Inventory ID": row.inventoryId,
    "Card Key": "",
    "Card Name": row.cardName,
    "Set / Series": row.setSeries,
    "Card Number": row.cardNumber,
    "Rarity": row.rarity ?? "",
    "Condition": row.condition,
    "Language": row.language,
    "Variant / Printing": row.variantPrinting || "Normal",
    "Purchase Date": row.purchaseDate ?? "",
    "Seller": row.seller ?? "",
    "Order ID": row.orderId ?? "",
    "Qty Purchased": row.qtyPurchased ?? 0,
    "Unit Cost (₱ each)": row.unitCost ?? 0,
    "Total Cost (₱)": row.totalCost ?? 0,
    "Expected Sell Price (₱)": "",
    "Avg. Actual Sell Price (₱)": "",
    "Qty Sold": 0,
    "Remaining Qty": row.remainingQty,
    "Total Revenue (₱)": 0,
    "Cost Sold (FIFO)": 0,
    "Realized Profit / Loss (₱)": 0,
    "Stock Status": "In Stock",
    "Status Override": "",
    "Notes": [
      row.skuId ? "SKU: " + row.skuId : "SKU: unresolved",
      row.resolutionState ? "Resolution: " + row.resolutionState : "",
      row.reviewFlags?.length ? "Review flags: " + row.reviewFlags.join(", ") : "",
      row.reviewNotes?.length ? "Review notes: " + row.reviewNotes.join(" | ") : "",
      row.resolutionReasons?.length ? "Resolution notes: " + row.resolutionReasons.join(" | ") : "",
    ].filter(Boolean).join(" "),
  };
  return {
    ...row,
    sourceRow: 0,
    rawCardKey: "",
    qtyPurchased: row.qtyPurchased ?? 0,
    unitCost: row.unitCost ?? 0,
    raw,
  };
}

export async function appendParsedInventoryRowsToGoogleSheets(
  rows: ParsedV2InventoryRow[],
): Promise<{ inserted: number; skipped: number }> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const sheetName = await verifySheetName(token, config.spreadsheetId, config.sheetName);
  const existing = await existingInventoryIds(token, config.spreadsheetId, sheetName);
  const pending = rows.filter((row) => !existing.has(row.inventoryId));
  if (pending.length > 0 && process.env.GOOGLE_SHEETS_BACKUP_ON_WRITE === "true") {
    await backupGoogleSheetTab(token, config.spreadsheetId, sheetName);
  }
  await ensureHeaderRow(token, config.spreadsheetId, sheetName);
  const inserted = await appendRows(token, config.spreadsheetId, sheetName, pending);

  return { inserted, skipped: rows.length - inserted };
}

interface SheetValueRange {
  values?: unknown[][];
}

async function readBatchValues(
  token: string,
  spreadsheetId: string,
  ranges: string[],
): Promise<SheetValueRange[]> {
  const query = ranges.map((item) => "ranges=" + encodeURIComponent(item)).join("&");
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) + "/values:batchGet?" + query + "&valueRenderOption=FORMATTED_VALUE";
  const body = await sheetsRequest<{ valueRanges?: SheetValueRange[] }>(token, url);
  return body.valueRanges ?? [];
}

export async function readGoogleSheetInventoryRows(): Promise<ParsedV2InventoryRow[]> {
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const sheetName = await verifySheetName(token, config.spreadsheetId, config.sheetName);
  const ranges = [quotedSheetRange(sheetName, "A3:Y5000")];
  const [inventory] = await readBatchValues(token, config.spreadsheetId, ranges);
  // The parser reports physical worksheet row numbers. The API range starts
  // at row 3, so preserve rows 1-2 before parsing.
  const parsed = parseV2InventorySheet([[], [], ...(inventory?.values ?? [])]);
  if (parsed.issues.length > 0) throw new Error("Google Sheets Inventory has parser issues: " + parsed.issues.map((issue) => issue.message).join(" | "));
  return parsed.rows;
}

export async function appendInventoryRowsDirectToGoogleSheets(
  rows: V2InventoryRow[],
): Promise<{ inserted: number; skipped: number }> {
  return appendParsedInventoryRowsToGoogleSheets(rows.map(inventoryRowToParsed));
}

export interface GoogleSaleWriteInput {
  saleId: string;
  cardKey: string;
  inventoryId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  condition: string;
  language: string;
  variantPrinting: string;
  dateSold: string;
  qtySold: number;
  sellPrice: number;
  notes?: string;
  allocations: Array<{ allocationId: string; inventoryId: string; qty: number }>;
}

export async function readGoogleSheetSaleIds(): Promise<string[]> {
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const [sales] = await readBatchValues(token, config.spreadsheetId, [quotedSheetRange("Sales Log", "A4:A5000")]);
  return (sales?.values ?? []).map((row) => String(row[0] ?? "").trim()).filter(Boolean);
}

export async function readGoogleSheetAllocationIds(): Promise<string[]> {
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const [allocations] = await readBatchValues(token, config.spreadsheetId, [quotedSheetRange("Cost Allocations", "A4:A5000")]);
  return (allocations?.values ?? []).map((row) => String(row[0] ?? "").trim()).filter(Boolean);
}

export async function writeSaleToGoogleSheets(input: GoogleSaleWriteInput): Promise<void> {
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);
  const inventorySheet = await verifySheetName(token, config.spreadsheetId, config.sheetName);
  const metadataUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(config.spreadsheetId) + "?fields=sheets.properties";
  const metadata = await sheetsRequest<{ sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> }>(token, metadataUrl);
  const sheetIds = new Map((metadata.sheets || [])
    .filter((sheet) => sheet.properties?.title && sheet.properties?.sheetId !== undefined)
    .map((sheet) => [sheet.properties!.title!, sheet.properties!.sheetId!] as const));
  const titles = new Set(sheetIds.keys());
  if (!titles.has("Sales Log") || !titles.has("Cost Allocations")) throw new Error("Google Sheets must contain Sales Log and Cost Allocations tabs.");

  const ranges = [quotedSheetRange(inventorySheet, "A3:Y5000"), quotedSheetRange("Sales Log", "A3:R5000"), quotedSheetRange("Cost Allocations", "A3:L5000")];
  const query = ranges.map((item) => "ranges=" + encodeURIComponent(item)).join("&");
  const readUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(config.spreadsheetId) + "/values:batchGet?" + query + "&valueRenderOption=FORMATTED_VALUE";
  const readBody = await sheetsRequest<{ valueRanges?: Array<{ values?: unknown[][] }> }>(token, readUrl);
  const inventoryValues = readBody.valueRanges?.[0]?.values || [];
  const salesValues = readBody.valueRanges?.[1]?.values || [];
  const allocationValues = readBody.valueRanges?.[2]?.values || [];
  // parseV2InventorySheet reports physical worksheet row numbers. The batchGet
  // range starts at row 3, so preserve those two leading rows when parsing;
  // otherwise sourceRow would be one row behind and inventory formulas would be
  // written to row 3/2 instead of the actual inventory lot row.
  const parsedInventory = parseV2InventorySheet([[], [], ...inventoryValues]);
  if (parsedInventory.issues.length > 0) throw new Error("Google Sheets Inventory has parser issues: " + parsedInventory.issues.map((issue) => issue.message).join(" | "));

  const selected = parsedInventory.rows.find((row) => row.inventoryId === input.inventoryId && row.rawCardKey === input.cardKey && row.remainingQty > 0);
  if (!selected) throw new Error("The selected inventory lot changed or is no longer available. Search again.");
  if (input.qtySold > selected.remainingQty) {
    throw new Error("Only " + selected.remainingQty + " unit(s) remain in the selected inventory lot.");
  }

  const currentAllocations: Array<{ inventoryId: string; qty: number }> = [
    { inventoryId: selected.inventoryId, qty: input.qtySold },
  ];
  if (currentAllocations.length !== input.allocations.length || currentAllocations.some((allocation, index) => allocation.inventoryId !== input.allocations[index].inventoryId || allocation.qty !== input.allocations[index].qty)) {
    throw new Error("The selected inventory lot changed while this sale was waiting for confirmation. Search again and prepare the sale again.");
  }

  const saleIds = salesValues.slice(1).map((row) => String(row[0] || "").trim()).filter(Boolean);
  if (saleIds.includes(input.saleId)) throw new Error("Sale ID " + input.saleId + " already exists. The sale was not written.");
  const allocationIds = allocationValues.slice(1).map((row) => String(row[0] || "").trim()).filter(Boolean);
  // The Sheets API may omit trailing completely-empty rows from a range response.
  // Treat the first omitted row as the next append position instead of calling the
  // sheet full. Row 3 is the header; writable rows are 4..5000.
  const findNextRow = (values: unknown[][], startRow: number, maxRow: number): number => {
    for (let index = 0; index < values.length; index += 1) {
      if (!String(values[index]?.[0] || "").trim()) return startRow + index;
    }
    const nextRow = startRow + values.length;
    return nextRow <= maxRow ? nextRow : maxRow + 1;
  };
  const salesRow = findNextRow(salesValues, 3, 5000);
  const allocationStart = findNextRow(allocationValues, 3, 5000);
  if (salesRow > 5000 || allocationStart + input.allocations.length - 1 > 5000) throw new Error("Sales Log or Cost Allocations is at capacity.");

  // Keep Sales Log Card Key identical to the authoritative Inventory Card Key.
  // Store the selected lot's key as a value so the new row is immediately
  // usable even before a spreadsheet recalculation pass.
  const authoritativeCardKey = selected.rawCardKey.trim();
  if (!authoritativeCardKey) throw new Error("Selected inventory lot has no Card Key. Repair the Inventory row before recording a sale.");
  const revenueFormula = "=IF(A" + salesRow + "=\"\",\"\",L" + salesRow + "*M" + salesRow + ")";
  const costFormula = "=IF(A" + salesRow + "=\"\",\"\",SUMIFS('Cost Allocations'!$G$4:$G$5000,'Cost Allocations'!$B$4:$B$5000,A" + salesRow + "))";
  const profitFormula = "=IF(A" + salesRow + "=\"\",\"\",N" + salesRow + "-O" + salesRow + ")";
  const checkFormula = "=IF(A" + salesRow + "=\"\",\"\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + salesRow + ")=L" + salesRow + ",\"OK\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + salesRow + ")=0,\"NOT ALLOCATED\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + salesRow + ")<L" + salesRow + ",\"PARTIAL\",\"OVER-ALLOCATED\"))))";

  const data: Array<{ range: string; majorDimension: string; values: unknown[][] }> = [
    { range: quotedSheetRange("Sales Log", "A" + salesRow + ":M" + salesRow), majorDimension: "ROWS", values: [[input.saleId, authoritativeCardKey, input.inventoryId, input.cardName, input.setSeries, input.cardNumber, input.rarity || "", input.condition, input.language, input.variantPrinting || "Normal", input.dateSold, input.qtySold, input.sellPrice]] },
    { range: quotedSheetRange("Sales Log", "N" + salesRow + ":P" + salesRow), majorDimension: "ROWS", values: [[revenueFormula, costFormula, profitFormula]] },
    { range: quotedSheetRange("Sales Log", "Q" + salesRow), majorDimension: "ROWS", values: [[input.notes || ""]] },
    { range: quotedSheetRange("Sales Log", "R" + salesRow), majorDimension: "ROWS", values: [[checkFormula]] },
  ];
  const inventoryFormulaData: Array<{ range: string; majorDimension: string; values: unknown[][] }> = [];

  for (let index = 0; index < input.allocations.length; index += 1) {
    const allocation = input.allocations[index];
    const row = allocationStart + index;
    const inventoryLot = parsedInventory.rows.find((candidate) => candidate.inventoryId === allocation.inventoryId);
    if (!inventoryLot) throw new Error("Selected inventory lot " + allocation.inventoryId + " no longer exists. Search again.");
    const unitCost = inventoryLot.unitCost;
    const allocatedCost = allocation.qty * unitCost;
    const allocatedRevenue = allocation.qty * input.sellPrice;
    data.push({ range: quotedSheetRange("Cost Allocations", "A" + row + ":J" + row), majorDimension: "ROWS", values: [[allocation.allocationId, input.saleId, allocation.inventoryId, inventoryLot.rawCardKey, allocation.qty, unitCost, allocatedCost, allocatedRevenue, allocatedRevenue - allocatedCost, "Selected Lot"]] });
    data.push({ range: quotedSheetRange("Cost Allocations", "L" + row), majorDimension: "ROWS", values: [["=IF(A" + row + "=\"\",\"\",IF(D" + row + "=\"ID NOT FOUND\",\"BAD INV ID\",IF(ISNA(MATCH(B" + row + ",'Sales Log'!$A$4:$A$5000,0)),\"BAD SALE ID\",IF(INDEX('Sales Log'!$B$4:$B$5000,MATCH(B" + row + ",'Sales Log'!$A$4:$A$5000,0))=D" + row + ",\"OK\",\"KEY MISMATCH\"))))"]] });
    // Reassert the Inventory quantity formulas on the selected lot. This keeps
    // the workbook formula-driven while ensuring Google Sheets has formulas present
    // even on rows whose formulas were previously missing or stale.
    inventoryFormulaData.push({
      range: quotedSheetRange(inventorySheet, "Q" + inventoryLot.sourceRow + ":W" + inventoryLot.sourceRow),
      majorDimension: "ROWS",
      values: [[
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",IF(R" + inventoryLot.sourceRow + "=0,\"\",T" + inventoryLot.sourceRow + "/R" + inventoryLot.sourceRow + "))",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$C$4:$C$5000,A" + inventoryLot.sourceRow + "))",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",M" + inventoryLot.sourceRow + "-R" + inventoryLot.sourceRow + ")",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",SUMIFS('Cost Allocations'!$H$4:$H$5000,'Cost Allocations'!$C$4:$C$5000,A" + inventoryLot.sourceRow + "))",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",SUMIFS('Cost Allocations'!$G$4:$G$5000,'Cost Allocations'!$C$4:$C$5000,A" + inventoryLot.sourceRow + "))",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",T" + inventoryLot.sourceRow + "-U" + inventoryLot.sourceRow + ")",
        "=IF(A" + inventoryLot.sourceRow + "=\"\",\"\",IF(X" + inventoryLot.sourceRow + "<>\"\",X" + inventoryLot.sourceRow + ",IF(S" + inventoryLot.sourceRow + "<0,\"Over-Allocated\",IF(S" + inventoryLot.sourceRow + "=0,\"Sold Out\",IF(R" + inventoryLot.sourceRow + "=0,\"In Stock\",\"Partially Sold\")))))",
      ]],
    });
  }

  if (process.env.GOOGLE_SHEETS_BACKUP_ON_WRITE === "true") {
    await backupGoogleSheetTab(token, config.spreadsheetId, "Sales Log");
    await backupGoogleSheetTab(token, config.spreadsheetId, "Cost Allocations");
  }
  const writeUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(config.spreadsheetId) + "/values:batchUpdate";
  // Cost Allocations must exist before Inventory R:S recalculates from it.
  await sheetsRequest(token, writeUrl, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });

  if (inventoryFormulaData.length > 0) {
    await sheetsRequest(token, writeUrl, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: inventoryFormulaData }),
    });
  }

  // New rows written through the Values API do not inherit the visual formatting
  // of the existing table. Copy only the formatting from the first data row so
  // dates, currency, borders, alignment, and status/check columns stay consistent.
  const salesSheetId = sheetIds.get("Sales Log");
  const allocationSheetId = sheetIds.get("Cost Allocations");
  if (salesSheetId === undefined || allocationSheetId === undefined) throw new Error("Sales Log or Cost Allocations sheet ID is missing.");
  const formatRequests: unknown[] = [
    {
      copyPaste: {
        source: { sheetId: salesSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 18 },
        destination: { sheetId: salesSheetId, startRowIndex: salesRow - 1, endRowIndex: salesRow, startColumnIndex: 0, endColumnIndex: 18 },
        pasteType: "PASTE_FORMAT",
      },
    },
    ...input.allocations.map((_, index) => ({
      copyPaste: {
        source: { sheetId: allocationSheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 12 },
        destination: { sheetId: allocationSheetId, startRowIndex: allocationStart + index - 1, endRowIndex: allocationStart + index, startColumnIndex: 0, endColumnIndex: 12 },
        pasteType: "PASTE_FORMAT",
      },
    })),
  ];
  const formatUrl = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(config.spreadsheetId) + ":batchUpdate";
  await sheetsRequest(token, formatUrl, { method: "POST", body: JSON.stringify({ requests: formatRequests }) });
}
