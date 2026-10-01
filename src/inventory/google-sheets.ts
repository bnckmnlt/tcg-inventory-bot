import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { V2_INVENTORY_HEADERS, type ParsedV2InventoryRow } from "./v2-workbook.js";
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

export async function appendInventoryRowsDirectToGoogleSheets(
  rows: V2InventoryRow[],
): Promise<{ inserted: number; skipped: number }> {
  return appendParsedInventoryRowsToGoogleSheets(rows.map(inventoryRowToParsed));
}
