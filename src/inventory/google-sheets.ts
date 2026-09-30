import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { V2_INVENTORY_HEADERS, type ParsedV2InventoryRow } from "./v2-workbook.js";

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
  return encodeURIComponent(`${sheetName}!${a1}`);
}

async function ensureHeaderRow(token: string, spreadsheetId: string, sheetName: string): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range(sheetName, "A1:Y1")}?valueInputOption=USER_ENTERED`;
  await sheetsRequest(token, url, {
    method: "PUT",
    body: JSON.stringify({ range: `${sheetName}!A1:Y1`, majorDimension: "ROWS", values: [V2_INVENTORY_HEADERS] }),
  });
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

  await ensureHeaderRow(token, config.spreadsheetId, config.sheetName);
  const existing = await existingInventoryIds(token, config.spreadsheetId, config.sheetName);
  const pending = parsed.rows.filter((row) => !existing.has(row.inventoryId));
  const inserted = await appendRows(token, config.spreadsheetId, config.sheetName, pending);

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

  const wanted = new Set(inventoryIds);
  const rows = parsed.rows.filter((row) => wanted.has(row.inventoryId));
  const config = loadConfig();
  const token = await getAccessToken(config.credentials);

  await ensureHeaderRow(token, config.spreadsheetId, config.sheetName);
  const existing = await existingInventoryIds(token, config.spreadsheetId, config.sheetName);
  const pending = rows.filter((row) => !existing.has(row.inventoryId));
  const inserted = await appendRows(token, config.spreadsheetId, config.sheetName, pending);

  return { inserted, skipped: rows.length - inserted };
}
