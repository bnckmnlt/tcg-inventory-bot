import AdmZip from "adm-zip";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvoiceData } from "../extract.js";
import type { IngestionPlan } from "./ingest.js";
import type { V2InventoryRow } from "./types.js";
import { readV2InventoryWorkbook } from "./read-xlsx.js";

export const WORKBOOK_CURRENCY = "PHP";

export interface WorkbookPersistenceOptions {
  /** Conversion from invoice currency into the workbook currency. */
  unitCostRate: number;
  /** Optional note shown in the workbook when a currency conversion was applied. */
  sourceCurrency?: string;
}

export interface WorkbookPersistenceResult {
  outputPath: string;
  inserted: number;
  skipped: number;
  pendingReview: number;
  insertedInventoryIds: string[];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelSerialDate(isoDate?: string): number | undefined {
  if (!isoDate) return undefined;
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const epoch = Date.UTC(1899, 11, 30);
  return (utc - epoch) / 86_400_000;
}

function templateStyles(sheetXml: string): Map<string, string> {
  const row = sheetXml.match(/<row r="49"[^>]*>[\s\S]*?<\/row>/)?.[0];
  if (!row) throw new Error("Inventory worksheet does not contain the expected V2 template row 49.");

  const styles = new Map<string, string>();
  for (const match of row.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>[\s\S]*?<\/c>/g)) {
    const attrs = match[1] ?? match[2] ?? "";
    const ref = attrs.match(/r="([A-Z]+)49"/)?.[1];
    const style = attrs.match(/s="(\d+)"/)?.[1];
    if (ref && style) styles.set(ref, style);
  }
  return styles;
}

function cell(ref: string, style: string | undefined, value: string | number | undefined, formula?: string): string {
  const s = style ? ` s="${style}"` : "";
  if (formula) {
    const type = typeof value === "string" ? ' t="str"' : "";
    const cached = value === undefined ? "" : `<v>${typeof value === "number" ? value : xmlEscape(value)}</v>`;
    return `<c r="${ref}"${s}${type}><f>${xmlEscape(formula)}</f>${cached}</c>`;
  }
  if (value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number") return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function buildInventoryRow(rowNumber: number, row: V2InventoryRow, styles: Map<string, string>, workbookCurrency: string, sourceCurrency?: string, unitCostRate = 1): string {
  if (!row.inventoryId || !row.cardName || !row.setSeries || !row.condition || !row.language) {
    throw new Error(`Cannot write inventory row ${rowNumber}: minimum identity fields are missing.`);
  }
  if (!Number.isInteger(row.qtyPurchased) || (row.qtyPurchased ?? 0) < 1) {
    throw new Error(`Cannot write inventory row ${rowNumber}: qtyPurchased must be a positive integer.`);
  }
  if (row.unitCost == null || !Number.isFinite(row.unitCost) || row.unitCost < 0) {
    throw new Error(`Cannot write inventory row ${rowNumber}: unitCost must be a non-negative number.`);
  }

  const sourceRateNote = sourceCurrency && sourceCurrency !== workbookCurrency
    ? `Source cost: ${sourceCurrency} ${row.unitCost.toFixed(4)}; FX rate to ${workbookCurrency}: ${unitCostRate}.`
    : "";
  const metadata = [
    row.skuId ? `SKU: ${row.skuId}` : "SKU: unresolved",
    row.resolutionState ? `Resolution: ${row.resolutionState}` : "",
    row.reviewFlags?.length ? `Review flags: ${row.reviewFlags.join(", ")}` : "",
    row.reviewNotes?.length ? `Review notes: ${row.reviewNotes.join(" | ")}` : "",
    row.resolutionReasons?.length ? `Resolution notes: ${row.resolutionReasons.join(" | ")}` : "",
    sourceRateNote,
  ].filter(Boolean);

  const convertedUnitCost = row.unitCost * unitCostRate;
  const totalCost = convertedUnitCost * (row.qtyPurchased ?? 0);
  const key = `${row.cardName}|${row.setSeries}|${row.cardNumber}|${row.rarity ?? ""}|${row.condition}|${row.language}|${row.variantPrinting}`.toUpperCase();
  const dateSerial = excelSerialDate(row.purchaseDate);

  const cells = [
    cell(`A${rowNumber}`, styles.get("A"), row.inventoryId),
    cell(`B${rowNumber}`, styles.get("B"), key, `IF(C${rowNumber}="","",UPPER(TRIM(C${rowNumber})&"|"&TRIM(D${rowNumber})&"|"&TRIM(E${rowNumber})&"|"&TRIM(F${rowNumber})&"|"&TRIM(G${rowNumber})&"|"&TRIM(H${rowNumber})&"|"&TRIM(I${rowNumber})))`),
    cell(`C${rowNumber}`, styles.get("C"), row.cardName),
    cell(`D${rowNumber}`, styles.get("D"), row.setSeries),
    cell(`E${rowNumber}`, styles.get("E"), row.cardNumber),
    cell(`F${rowNumber}`, styles.get("F"), row.rarity),
    cell(`G${rowNumber}`, styles.get("G"), row.condition),
    cell(`H${rowNumber}`, styles.get("H"), row.language),
    cell(`I${rowNumber}`, styles.get("I"), row.variantPrinting || "Normal"),
    cell(`J${rowNumber}`, styles.get("J"), dateSerial),
    cell(`K${rowNumber}`, styles.get("K"), row.seller),
    cell(`L${rowNumber}`, styles.get("L"), row.orderId),
    cell(`M${rowNumber}`, styles.get("M"), row.qtyPurchased),
    cell(`N${rowNumber}`, styles.get("N"), convertedUnitCost),
    cell(`O${rowNumber}`, styles.get("O"), totalCost, `IF(A${rowNumber}="","",M${rowNumber}*N${rowNumber})`),
    cell(`P${rowNumber}`, styles.get("P"), undefined),
    cell(`Q${rowNumber}`, styles.get("Q"), undefined, `IF(A${rowNumber}="","",IF(R${rowNumber}=0,"",T${rowNumber}/R${rowNumber}))`),
    cell(`R${rowNumber}`, styles.get("R"), 0, `IF(A${rowNumber}="","",SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$C$4:$C$5000,A${rowNumber}))`),
    cell(`S${rowNumber}`, styles.get("S"), row.remainingQty, `IF(A${rowNumber}="","",M${rowNumber}-R${rowNumber})`),
    cell(`T${rowNumber}`, styles.get("T"), 0, `IF(A${rowNumber}="","",SUMIFS('Cost Allocations'!$H$4:$H$5000,'Cost Allocations'!$C$4:$C$5000,A${rowNumber}))`),
    cell(`U${rowNumber}`, styles.get("U"), 0, `IF(A${rowNumber}="","",SUMIFS('Cost Allocations'!$G$4:$G$5000,'Cost Allocations'!$C$4:$C$5000,A${rowNumber}))`),
    cell(`V${rowNumber}`, styles.get("V"), 0, `IF(A${rowNumber}="","",T${rowNumber}-U${rowNumber})`),
    cell(`W${rowNumber}`, styles.get("W"), "In Stock", `IF(A${rowNumber}="","",IF(X${rowNumber}<>"",X${rowNumber},IF(S${rowNumber}<0,"Over-Allocated",IF(S${rowNumber}=0,"Sold Out",IF(R${rowNumber}=0,"In Stock","Partially Sold")))))`),
    cell(`X${rowNumber}`, styles.get("X"), undefined),
    cell(`Y${rowNumber}`, styles.get("Y"), metadata.join(" ")),
  ];

  return `<row r="${rowNumber}" ht="15.75" customHeight="1">${cells.join("")}</row>`;
}

function shiftRows(sheetData: string, insertAt: number, count: number): string {
  return sheetData.replace(/<row\b([^>]*)>[\s\S]*?<\/row>/g, (full, attrs: string) => {
    const match = attrs.match(/\br="(\d+)"/);
    if (!match) return full;
    const rowNumber = Number(match[1]);
    if (rowNumber < insertAt) return full;
    const shifted = rowNumber + count;
    const shiftedAttrs = attrs.replace(/\br="\d+"/, `r="${shifted}"`);
    return full.replace(attrs, shiftedAttrs).replace(/([A-Z]+)\d+/g, (ref: string) => {
      const col = ref.match(/^[A-Z]+/)?.[0] ?? ref;
      return `${col}${shifted}`;
    });
  });
}

function updateInventorySheet(source: string, rows: V2InventoryRow[], options: WorkbookPersistenceOptions): string {
  const sheetPath = join(source, "xl", "worksheets", "sheet3.xml");
  let xml = readFileSync(sheetPath, "utf8");
  const styles = templateStyles(xml);
  const insertAt = 50;
  const count = rows.length;

  if (count === 0) return xml;

  const sheetDataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetDataMatch) throw new Error("Inventory worksheet has no sheetData.");

  const originalRows = sheetDataMatch[1];
  const before = originalRows.replace(/<row\b([^>]*)>[\s\S]*?<\/row>/g, (full, attrs: string) => {
    const match = attrs.match(/\br="(\d+)"/);
    return match && Number(match[1]) < insertAt ? full : "";
  });
  const shifted = shiftRows(originalRows, insertAt, count).replace(/<row\b([^>]*)>[\s\S]*?<\/row>/g, (full, attrs: string) => {
    const match = attrs.match(/\br="(\d+)"/);
    return match && Number(match[1]) >= insertAt + count ? full : "";
  });
  const newRows = rows.map((row, index) =>
    buildInventoryRow(insertAt + index, row, styles, WORKBOOK_CURRENCY, options.sourceCurrency, options.unitCostRate),
  ).join("");

  const withRows = `<sheetData>${before}${newRows}${shifted}</sheetData>`;
  xml = xml.replace(sheetDataMatch[0], withRows);

  xml = xml.replace(/\$A\$3:\$Y\$1000/g, `$A$3:$Y$${1000 + count}`);
  xml = xml.replace(/W4:W1000/g, `W4:W${1000 + count}`);
  xml = xml.replace(/S4:S1000/g, `S4:S${1000 + count}`);
  xml = xml.replace(/G4:G1000/g, `G4:G${1000 + count}`);
  xml = xml.replace(/X4:X1000/g, `X4:X${1000 + count}`);
  xml = xml.replace(/I4:I1000/g, `I4:I${1000 + count}`);
  xml = xml.replace(/F4:F1000/g, `F4:F${1000 + count}`);
  xml = xml.replace(/N4:N1000 P4:P1000/g, `N4:N${1000 + count} P4:P${1000 + count}`);
  xml = xml.replace(/J4:J1000/g, `J4:J${1000 + count}`);
  xml = xml.replace(/H4:H1000/g, `H4:H${1000 + count}`);
  xml = xml.replace(/M4:M1000/g, `M4:M${1000 + count}`);

  writeFileSync(sheetPath, xml);
  return xml;
}

function updateWorkbookDefinedNames(source: string, count: number): void {
  const path = join(source, "xl", "workbook.xml");
  let xml = readFileSync(path, "utf8");
  xml = xml.replace(/Inventory!\$A\$3:\$Y\$1000/g, `Inventory!$A$3:$Y$${1000 + count}`);
  writeFileSync(path, xml);
}

function packDirectory(directory: string, outputPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(directory);
  zip.writeZip(outputPath);
}

export function appendInventoryRowsToWorkbook(
  sourceWorkbookPath: string,
  outputWorkbookPath: string,
  rows: V2InventoryRow[],
  options: WorkbookPersistenceOptions,
): WorkbookPersistenceResult {
  if (!Number.isFinite(options.unitCostRate) || options.unitCostRate <= 0) {
    throw new Error("unitCostRate must be a positive finite number.");
  }
  if (rows.length === 0) {
    copyFileSync(sourceWorkbookPath, outputWorkbookPath);
    return { outputPath: outputWorkbookPath, inserted: 0, skipped: 0, pendingReview: 0, insertedInventoryIds: [] };
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "tcg-inventory-workbook-"));
  const unpacked = join(tempRoot, "xlsx");
  const zip = new AdmZip(sourceWorkbookPath);
  zip.extractAllTo(unpacked, true);
  try {
    updateInventorySheet(unpacked, rows, options);
    updateWorkbookDefinedNames(unpacked, rows.length);
    packDirectory(unpacked, outputWorkbookPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  return {
    outputPath: outputWorkbookPath,
    inserted: rows.length,
    skipped: 0,
    pendingReview: 0,
    insertedInventoryIds: rows.map((row) => row.inventoryId),
  };
}

export function invoicePlanToWorkbookRows(
  plan: IngestionPlan,
  invoice: InvoiceData,
  options: WorkbookPersistenceOptions,
): V2InventoryRow[] {
  if (!invoice.currency) throw new Error("Invoice currency is required before workbook persistence.");
  if (!Number.isFinite(options.unitCostRate) || options.unitCostRate <= 0) {
    throw new Error("unitCostRate must be a positive finite number.");
  }

  return plan.rows
    .filter((planned) => planned.action === "INSERT")
    .map((planned) => {
      const row = planned.input;
      if (row.unitCost == null) throw new Error(`Invoice line ${planned.sourceLine} has no unit cost.`);
      return {
        ...row,
        totalCost: row.unitCost * options.unitCostRate * (row.qtyPurchased ?? 0),
      };
    });
}

export function createSafeWorkbookOutput(sourceWorkbookPath: string, outputWorkbookPath: string, plan: IngestionPlan, invoice: InvoiceData, options: WorkbookPersistenceOptions): WorkbookPersistenceResult {
  const rows = invoicePlanToWorkbookRows(plan, invoice, options);
  return appendInventoryRowsToWorkbook(sourceWorkbookPath, outputWorkbookPath, rows, {
    ...options,
    sourceCurrency: options.sourceCurrency ?? invoice.currency ?? undefined,
  });
}

export function persistInvoicePlanToWorkbookSafely(
  workbookPath: string,
  plan: IngestionPlan,
  invoice: InvoiceData,
  options: WorkbookPersistenceOptions,
): WorkbookPersistenceResult {
  if (!existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);

  const source = readV2InventoryWorkbook(workbookPath);
  if (source.issues.length > 0) {
    throw new Error(`Source workbook has parser issues; refusing to write: ${source.issues.map((issue) => issue.message).join(" | ")}`);
  }

  const existingIds = new Set(source.rows.map((row) => row.inventoryId));
  const newRows = invoicePlanToWorkbookRows(plan, invoice, options).filter((row) => !existingIds.has(row.inventoryId));
  const alreadyPersistedCount = plan.insertable - newRows.length;
  const persistencePlan: IngestionPlan = {
    ...plan,
    rows: plan.rows.map((planned) =>
      planned.action === "INSERT" && planned.inventoryId && existingIds.has(planned.inventoryId)
        ? { ...planned, action: "SKIP", reasons: [...planned.reasons, "This inventory row is already present in the workbook; safe retry is a no-op."] }
        : planned,
    ),
    insertable: newRows.length,
    skipped: plan.skipped + alreadyPersistedCount,
  };

  if (newRows.length === 0) {
    return {
      outputPath: workbookPath,
      inserted: 0,
      skipped: persistencePlan.skipped,
      pendingReview: persistencePlan.pendingReview,
      insertedInventoryIds: [],
    };
  }

  const expectedPurchased = source.rows.reduce((sum, row) => sum + row.qtyPurchased, 0) + newRows.reduce((sum, row) => sum + (row.qtyPurchased ?? 0), 0);
  const expectedRemaining = source.rows.reduce((sum, row) => sum + row.remainingQty, 0) + newRows.reduce((sum, row) => sum + row.remainingQty, 0);

  const tempPath = `${workbookPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    createSafeWorkbookOutput(workbookPath, tempPath, persistencePlan, invoice, options);
    const candidate = readV2InventoryWorkbook(tempPath);
    if (candidate.issues.length > 0) {
      throw new Error(`Generated workbook failed parser validation: ${candidate.issues.map((issue) => issue.message).join(" | ")}`);
    }

    const purchased = candidate.rows.reduce((sum, row) => sum + row.qtyPurchased, 0);
    const remaining = candidate.rows.reduce((sum, row) => sum + row.remainingQty, 0);
    const candidateIds = new Set(candidate.rows.map((row) => row.inventoryId));
    if (candidate.rows.length !== source.rows.length + newRows.length) {
      throw new Error("Workbook row-count regression: expected " + (source.rows.length + newRows.length) + ", got " + candidate.rows.length + ".");
    }
    if (purchased !== expectedPurchased || remaining !== expectedRemaining) {
      throw new Error(`Workbook quantity regression: expected purchased/remaining ${expectedPurchased}/${expectedRemaining}, got ${purchased}/${remaining}.`);
    }
    for (const row of newRows) {
      if (!candidateIds.has(row.inventoryId)) throw new Error(`Inserted inventory ID is missing from candidate workbook: ${row.inventoryId}`);
    }

    renameSync(tempPath, workbookPath);
    return {
      outputPath: workbookPath,
      inserted: newRows.length,
      skipped: persistencePlan.skipped,
      pendingReview: persistencePlan.pendingReview,
      insertedInventoryIds: newRows.map((row) => row.inventoryId),
    };
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
}
