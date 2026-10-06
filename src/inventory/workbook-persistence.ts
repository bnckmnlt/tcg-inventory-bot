import AdmZip from "adm-zip";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvoiceData } from "../extract.js";
import type { IngestionPlan } from "./ingest.js";
import type { V2InventoryRow } from "./types.js";
import { readV2InventoryWorkbook } from "./read-xlsx.js";
import { buildInventoryCardKey } from "./v2-workbook.js";

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

export interface LocalSalePersistenceInput {
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

function updateInventorySheet(source: string, rows: V2InventoryRow[], options: WorkbookPersistenceOptions): string {
  const sheetPath = join(source, "xl", "worksheets", "sheet3.xml");
  let xml = readFileSync(sheetPath, "utf8");
  const styles = templateStyles(xml);
  // Rows 1-3 are the title/header area. Row 4 is the first inventory data row;
  // row 49 is only used as the formatting/template source for new rows.
  const insertAt = 4;
  const count = rows.length;

  if (count === 0) return xml;

  const sheetDataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetDataMatch) throw new Error("Inventory worksheet has no sheetData.");

  const originalRows = sheetDataMatch[1];
  const rowPattern = /<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g;
  const existingRows = [...originalRows.matchAll(rowPattern)].map((match) => match[0]);
  const populatedRows = existingRows
    .map((rowXml) => {
      const rowNumber = Number(rowXml.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? 0);
      const hasInventoryId = new RegExp(`<c\\b[^>]*\\br="A${rowNumber}"[^>]*>`).test(rowXml) && !new RegExp(`<c\\b[^>]*\\br="A${rowNumber}"[^>]*/>`).test(rowXml);
      return hasInventoryId ? rowNumber : 0;
    })
    .filter((rowNumber) => rowNumber >= insertAt);
  const lastInventoryRow = populatedRows.length > 0 ? Math.max(...populatedRows) : insertAt - 1;
  const appendAt = Math.max(insertAt, lastInventoryRow + 1);
  const newRows = rows.map((row, index) =>
    buildInventoryRow(appendAt + index, row, styles, WORKBOOK_CURRENCY, options.sourceCurrency, options.unitCostRate),
  );
  const newByRow = new Map(newRows.map((rowXml, index) => [appendAt + index, rowXml]));

  let appendedRows = "";
  const rewrittenRows = existingRows.map((rowXml) => {
    const rowNumber = Number(rowXml.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? 0);
    const replacement = newByRow.get(rowNumber);
    if (replacement) {
      newByRow.delete(rowNumber);
      return replacement;
    }
    return rowXml;
  });
  appendedRows = [...newByRow.values()].join("");
  const withRows = rewrittenRows.join("") + appendedRows;
  xml = xml.replace(sheetDataMatch[0], `<sheetData>${withRows}</sheetData>`);

  const appendEndRow = appendAt + count - 1;
  const extendRange = (pattern: RegExp, prefix: string): void => {
    xml = xml.replace(pattern, (full, currentEnd: string) => {
      const endRow = Math.max(Number(currentEnd), appendEndRow);
      return `${prefix}${endRow}`;
    });
  };

  extendRange(/\$A\$3:\$Y\$(\d+)/g, "$A$3:$Y$");
  extendRange(/W4:W(\d+)/g, "W4:W");
  extendRange(/S4:S(\d+)/g, "S4:S");
  extendRange(/G4:G(\d+)/g, "G4:G");
  extendRange(/X4:X(\d+)/g, "X4:X");
  extendRange(/I4:I(\d+)/g, "I4:I");
  extendRange(/F4:F(\d+)/g, "F4:F");
  xml = xml.replace(/N4:N(\d+) P4:P(\d+)/g, (_full, nEnd: string, pEnd: string) => {
    const endRow = Math.max(Number(nEnd), Number(pEnd), appendEndRow);
    return `N4:N${endRow} P4:P${endRow}`;
  });
  extendRange(/J4:J(\d+)/g, "J4:J");
  extendRange(/H4:H(\d+)/g, "H4:H");
  extendRange(/M4:M(\d+)/g, "M4:M");

  writeFileSync(sheetPath, xml);
  return xml;
}

function invalidateFormulaCaches(directory: string): void {
  const files = readdirSync(join(directory, "xl", "worksheets"))
    .filter((file) => file.startsWith("sheet") && file.endsWith(".xml"));
  for (const file of files) {
    const path = join(directory, "xl", "worksheets", file);
    let xml = readFileSync(path, "utf8");
    xml = xml.replace(/(<c[^>]*><f[^>]*>[^]*?<\/f>)<v>[^]*?<\/v>/g, "$1");
    xml = xml.replace(/(<c[^>]*><f[^>]*\/>)<v>[^]*?<\/v>/g, "$1");
    writeFileSync(path, xml);
  }
}

function updateWorkbookDefinedNames(source: string, count: number): void {
  const path = join(source, "xl", "workbook.xml");
  let xml = readFileSync(path, "utf8");
  xml = xml.replace(/Inventory!\$A\$3:\$Y\$1000/g, `Inventory!$A$3:$Y$${1000 + count}`);
  xml = xml.replace(/<calcPr(?:[^>]*)\/>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
  writeFileSync(path, xml);
}

function packDirectory(directory: string, outputPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(directory);
  zip.writeZip(outputPath);
}

function appendRowsToSheetXml(sheetPath: string, rows: string[], firstDataRow: number, lastColumn: string): void {
  let xml = readFileSync(sheetPath, "utf8");
  const sheetDataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sheetDataMatch) throw new Error("Worksheet " + sheetPath + " has no sheetData.");
  const existingRows = [...sheetDataMatch[1].matchAll(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)].map((match) => match[0]);
  const populatedRows = existingRows.map((rowXml) => {
    const rowNumber = Number(rowXml.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? 0);
    const hasId = new RegExp("<c\\b[^>]*\\br=\"A" + rowNumber + "\"[^>]*>([\\s\\S]*?)</c>").test(rowXml)
      && !new RegExp("<c\\b[^>]*\\br=\"A" + rowNumber + "\"[^>]*/>").test(rowXml);
    return hasId ? rowNumber : 0;
  }).filter((rowNumber) => rowNumber >= firstDataRow);
  const populatedSet = new Set(populatedRows);
  const blankRows: number[] = [];
  const existingRowNumbers = new Set<number>();
  for (const rowXml of existingRows) {
    const rowNumber = Number(rowXml.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? 0);
    if (rowNumber >= firstDataRow) {
      existingRowNumbers.add(rowNumber);
      if (!populatedSet.has(rowNumber)) blankRows.push(rowNumber);
    }
  }

  const startRow = Math.max(firstDataRow, populatedRows.length ? Math.max(...populatedRows) + 1 : firstDataRow);
  const replacementRows = blankRows.filter((rowNumber) => rowNumber >= firstDataRow).slice(0, rows.length);
  const appendCount = rows.length - replacementRows.length;
  const appendStartRow = Math.max(startRow, ...replacementRows, firstDataRow) + (replacementRows.length > 0 ? 1 : 0);
  const assignedRows = [
    ...replacementRows,
    ...Array.from({ length: appendCount }, (_, index) => appendStartRow + index),
  ];

  let updatedSheetData = sheetDataMatch[1];
  for (let index = 0; index < assignedRows.length; index += 1) {
    const rowNumber = assignedRows[index];
    const newRow = rows[index].replace(/ROW_NUMBER/g, String(rowNumber));
    const existingRowPattern = new RegExp("<row\\b[^>]*\\br=\"" + rowNumber + "\"[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)");
    if (existingRowPattern.test(updatedSheetData)) {
      updatedSheetData = updatedSheetData.replace(existingRowPattern, newRow);
    } else {
      updatedSheetData += newRow;
    }
  }

  xml = xml.replace(sheetDataMatch[0], "<sheetData>" + updatedSheetData + "</sheetData>");
  const finalRow = Math.max(...assignedRows, firstDataRow);
  xml = xml.replace(/<dimension ref="A1:[A-Z]+\d+"\/>/, "<dimension ref=\"A1:" + lastColumn + finalRow + "\"/>");
  writeFileSync(sheetPath, xml);
}

function sheetTemplateStyles(sheetXml: string, templateRow: number, columns: string[]): Map<string, string> {
  const row = sheetXml.match(new RegExp("<row r=\"" + templateRow + "\"[^>]*>[\\s\\S]*?</row>"))?.[0];
  if (!row) throw new Error("Worksheet does not contain template row " + templateRow + ".");
  const styles = new Map<string, string>();
  for (const column of columns) {
    const style = row.match(new RegExp("<c\\b[^>]*\\br=\"" + column + templateRow + "\"[^>]*\\bs=\"(\\d+)\""))?.[1];
    if (style) styles.set(column, style);
  }
  return styles;
}

function workbookCell(ref: string, style: string | undefined, value: string | number | undefined, formula?: string): string {
  const s = style ? " s=\"" + style + "\"" : "";
  if (formula) return "<c r=\"" + ref + "\"" + s + "><f>" + xmlEscape(formula) + "</f></c>";
  if (value === undefined || value === "") return "<c r=\"" + ref + "\"" + s + "/>";
  if (typeof value === "number") return "<c r=\"" + ref + "\"" + s + "><v>" + value + "</v></c>";
  return "<c r=\"" + ref + "\"" + s + " t=\"inlineStr\"><is><t>" + xmlEscape(value) + "</t></is></c>";
}

function findNextXmlRow(xml: string, firstDataRow: number): number {
  const rows = xml.match(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g) ?? [];
  const populated = rows.map((rowXml) => {
    const rowNumber = Number(rowXml.match(/<row\b[^>]*\br="(\d+)"/)?.[1] ?? 0);
    return new RegExp("<c\\b[^>]*\\br=\"A" + rowNumber + "\"[^>]*>([\\s\\S]*?)</c>").test(rowXml) ? rowNumber : 0;
  }).filter((rowNumber) => rowNumber >= firstDataRow);
  return populated.length ? Math.max(...populated) + 1 : firstDataRow;
}

function setFormulaCachedValue(xml: string, cellRef: string, value: number | string): string {
  const pattern = new RegExp("<c[^>]*r=\"" + cellRef + "\"[^>]*>([\\s\\S]*?)</c>");
  return xml.replace(pattern, (_full, body: string) => {
    if (!/<f[ >]/.test(body)) return _full;
    const encoded = xmlEscape(String(value));
    const withoutValue = body.replace(/<v[^>]*>[\s\S]*?<\/v>/, "");
    return _full.replace(body, withoutValue + "<v>" + encoded + "</v>");
  });
}

function updateInventoryFormulaCaches(
  sheetXml: string,
  inventory: ReturnType<typeof readV2InventoryWorkbook>,
  allocations: Array<{ inventoryId: string; qty: number }>,
): string {
  const lotsById = new Map(inventory.rows.map((row) => [row.inventoryId, row]));
  const allocatedByLot = new Map<string, number>();
  for (const allocation of allocations) {
    allocatedByLot.set(allocation.inventoryId, (allocatedByLot.get(allocation.inventoryId) ?? 0) + allocation.qty);
  }

  // Restore the cached availability values for every inventory lot, not just
  // the lots touched by this sale. Formula caches are cleared before this
  // helper runs, so restoring only the current sale's lot would erase the
  // cached Remaining Qty for previously sold lots. The next /sale read would
  // then see those rows as available again.
  let xml = sheetXml;
  for (const lot of inventory.rows) {
    const saleQty = allocatedByLot.get(lot.inventoryId) ?? 0;
    const remaining = Math.max(0, lot.remainingQty - saleQty);
    const qtySold = Math.max(0, lot.qtyPurchased - remaining);
    const status = remaining === 0 ? "Sold Out" : remaining < lot.qtyPurchased ? "Partially Sold" : "In Stock";
    xml = setFormulaCachedValue(xml, "R" + lot.sourceRow, qtySold);
    xml = setFormulaCachedValue(xml, "S" + lot.sourceRow, remaining);
    xml = setFormulaCachedValue(xml, "W" + lot.sourceRow, status);
  }

  for (const inventoryId of allocatedByLot.keys()) {
    if (!lotsById.has(inventoryId)) throw new Error("Inventory lot " + inventoryId + " no longer exists.");
  }

  return xml;
}

export function readWorkbookIds(workbookPath: string, sheetNumber: number, prefix: "SALE" | "ALLOC"): string[] {
  if (!existsSync(workbookPath)) throw new Error("Workbook not found: " + workbookPath);
  const tempRoot = mkdtempSync(join(tmpdir(), "tcg-inventory-ids-"));
  const unpacked = join(tempRoot, "xlsx");
  new AdmZip(workbookPath).extractAllTo(unpacked, true);
  try {
    const xml = readFileSync(join(unpacked, "xl", "worksheets", "sheet" + sheetNumber + ".xml"), "utf8");
    return [...xml.matchAll(new RegExp(prefix + "-\\d+", "gi"))].map((match) => match[0]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function persistSaleToWorkbook(workbookPath: string, input: LocalSalePersistenceInput): void {
  if (!existsSync(workbookPath)) throw new Error("Workbook not found: " + workbookPath);
  if (!Number.isInteger(input.qtySold) || input.qtySold < 1) throw new Error("Quantity must be a positive integer.");
  if (!Number.isFinite(input.sellPrice) || input.sellPrice < 0) throw new Error("Sell price must be a non-negative number.");

  const tempRoot = mkdtempSync(join(tmpdir(), "tcg-inventory-sale-"));
  const unpacked = join(tempRoot, "xlsx");
  new AdmZip(workbookPath).extractAllTo(unpacked, true);
  try {
    const salesPath = join(unpacked, "xl", "worksheets", "sheet4.xml");
    const allocationsPath = join(unpacked, "xl", "worksheets", "sheet5.xml");
    const salesXml = readFileSync(salesPath, "utf8");
    const allocationXml = readFileSync(allocationsPath, "utf8");
    const existingSaleIds = [...salesXml.matchAll(/<t>(SALE-\d+)<\/t>/gi)].map((match) => match[1]);
    if (existingSaleIds.includes(input.saleId)) {
      throw new Error("Sale ID " + input.saleId + " already exists. The sale was not written.");
    }

    const salesStyles = sheetTemplateStyles(salesXml, 4, ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R"]);
    const allocationStyles = sheetTemplateStyles(allocationXml, 4, ["A","B","C","D","E","F","G","H","I","J","K","L"]);
    const inventory = readV2InventoryWorkbook(workbookPath);
    const lotById = new Map(inventory.rows.map((row) => [row.inventoryId, row]));
    const saleRow = findNextXmlRow(salesXml, 4);
    const allocationRow = findNextXmlRow(allocationXml, 4);
    const revenueFormula = "IF(A" + saleRow + "=\"\",\"\",L" + saleRow + "*M" + saleRow + ")";
    const costFormula = "IF(A" + saleRow + "=\"\",\"\",SUMIFS('Cost Allocations'!$G$4:$G$5000,'Cost Allocations'!$B$4:$B$5000,A" + saleRow + "))";
    const profitFormula = "IF(A" + saleRow + "=\"\",\"\",N" + saleRow + "-O" + saleRow + ")";
    const checkFormula = "IF(A" + saleRow + "=\"\",\"\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + saleRow + ")=L" + saleRow + ",\"OK\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + saleRow + ")=0,\"NOT ALLOCATED\",IF(SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$B$4:$B$5000,A" + saleRow + ")<L" + saleRow + ",\"PARTIAL\",\"OVER-ALLOCATED\"))))";
    const dateSerial = excelSerialDate(input.dateSold);
    const salesCells = [
      workbookCell("AROW_NUMBER", salesStyles.get("A"), input.saleId),
      workbookCell("BROW_NUMBER", salesStyles.get("B"), input.cardKey),
      workbookCell("CROW_NUMBER", salesStyles.get("C"), input.inventoryId),
      workbookCell("DROW_NUMBER", salesStyles.get("D"), input.cardName),
      workbookCell("EROW_NUMBER", salesStyles.get("E"), input.setSeries),
      workbookCell("FROW_NUMBER", salesStyles.get("F"), input.cardNumber),
      workbookCell("GROW_NUMBER", salesStyles.get("G"), input.rarity || ""),
      workbookCell("HROW_NUMBER", salesStyles.get("H"), input.condition),
      workbookCell("IROW_NUMBER", salesStyles.get("I"), input.language),
      workbookCell("JROW_NUMBER", salesStyles.get("J"), input.variantPrinting || "Normal"),
      workbookCell("KROW_NUMBER", salesStyles.get("K"), dateSerial),
      workbookCell("LROW_NUMBER", salesStyles.get("L"), input.qtySold),
      workbookCell("MROW_NUMBER", salesStyles.get("M"), input.sellPrice),
      workbookCell("NROW_NUMBER", salesStyles.get("N"), undefined, revenueFormula),
      workbookCell("OROW_NUMBER", salesStyles.get("O"), undefined, costFormula),
      workbookCell("PROW_NUMBER", salesStyles.get("P"), undefined, profitFormula),
      workbookCell("QROW_NUMBER", salesStyles.get("Q"), input.notes || ""),
      workbookCell("RROW_NUMBER", salesStyles.get("R"), undefined, checkFormula),
    ];
    appendRowsToSheetXml(salesPath, ["<row r=\"ROW_NUMBER\" ht=\"15.75\" customHeight=\"1\">" + salesCells.join("") + "</row>"], 4, "R");

    const allocationRows = input.allocations.map((allocation) => {
      const lot = lotById.get(allocation.inventoryId);
      if (!lot) throw new Error("Inventory lot " + allocation.inventoryId + " no longer exists. Search again.");
      const row = allocationRow + input.allocations.indexOf(allocation);
      const allocatedCost = allocation.qty * lot.unitCost;
      const allocatedRevenue = allocation.qty * input.sellPrice;
      const keyCheck = "IF(A" + row + "=\"\",\"\",IF(D" + row + "=\"ID NOT FOUND\",\"BAD INV ID\",IF(ISNA(MATCH(B" + row + ",'Sales Log'!$A$4:$A$5000,0)),\"BAD SALE ID\",IF(INDEX('Sales Log'!$B$4:$B$5000,MATCH(B" + row + ",'Sales Log'!$A$4:$A$5000,0))=D" + row + ",\"OK\",\"KEY MISMATCH\"))))";
      return "<row r=\"ROW_NUMBER\" ht=\"15.75\" customHeight=\"1\">" + [
        workbookCell("AROW_NUMBER", allocationStyles.get("A"), allocation.allocationId),
        workbookCell("BROW_NUMBER", allocationStyles.get("B"), input.saleId),
        workbookCell("CROW_NUMBER", allocationStyles.get("C"), allocation.inventoryId),
        workbookCell("DROW_NUMBER", allocationStyles.get("D"), buildInventoryCardKey(lot)),
        workbookCell("EROW_NUMBER", allocationStyles.get("E"), allocation.qty),
        workbookCell("FROW_NUMBER", allocationStyles.get("F"), lot.unitCost),
        workbookCell("GROW_NUMBER", allocationStyles.get("G"), allocatedCost),
        workbookCell("HROW_NUMBER", allocationStyles.get("H"), allocatedRevenue),
        workbookCell("IROW_NUMBER", allocationStyles.get("I"), allocatedRevenue - allocatedCost),
        workbookCell("JROW_NUMBER", allocationStyles.get("J"), "Selected Lot"),
        workbookCell("KROW_NUMBER", allocationStyles.get("K"), undefined),
        workbookCell("LROW_NUMBER", allocationStyles.get("L"), undefined, keyCheck),
      ].join("") + "</row>";
    });
    appendRowsToSheetXml(allocationsPath, allocationRows, 4, "L");

    invalidateFormulaCaches(unpacked);

    // Restore the availability-related formula caches after invalidation.
    // The bot reads XLSX values directly when building the Discord dropdown,
    // while Excel/Google Sheets can still recalculate the formulas normally.
    const inventoryPath = join(unpacked, "xl", "worksheets", "sheet3.xml");
    const updatedInventoryXml = updateInventoryFormulaCaches(
      readFileSync(inventoryPath, "utf8"),
      inventory,
      input.allocations,
    );
    writeFileSync(inventoryPath, updatedInventoryXml);
    const output = workbookPath + ".tmp-" + process.pid + "-" + Date.now();
    packDirectory(unpacked, output);
    renameSync(output, workbookPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function replaceXmlCellValue(xml: string, cellRef: string, value: string | number | undefined): string {
  const pattern = new RegExp('<c\\\\b([^>]*\\\\br="' + cellRef + '"[^>]*)>([\\\\s\\\\S]*?)</c>');
  return xml.replace(pattern, (_full, attrs: string) => cell(cellRef, attrs.match(/\bs="(\d+)"/)?.[1], value));
}

function replaceXmlFormulaCachedValue(xml: string, cellRef: string, value: number | string): string {
  const pattern = new RegExp('(<c\\\\b[^>]*\\\\br="' + cellRef + '"[^>]*>)([\\\\s\\\\S]*?)(</c>)');
  return xml.replace(pattern, (_full, open: string, body: string, close: string) => {
    if (!/<f[ >]/.test(body)) return _full;
    const withoutValue = body.replace(new RegExp("<v[^>]*>[\\\\s\\\\S]*?</v>"), "");
    return open + withoutValue + "<v>" + xmlEscape(String(value)) + "</v>" + close;
  });
}

function findSheetRowByColumnValue(xml: string, column: string, value: string): number {
  for (const match of xml.matchAll(new RegExp('<row\\b[^>]*\\br="(\\d+)"[^>]*>[\\s\\S]*?</row>', "g"))) {
    const rowNumber = Number(match[1]);
    const rowXml = match[0];
    const cellMatch = rowXml.match(new RegExp(String.raw`<c\\b[^>]*\\br="${column}${rowNumber}"[^>]*>[\\s\\S]*?</c>`));
    if (!cellMatch) continue;
    const body = cellMatch[0];
    const inline = body.match(new RegExp("<t[^>]*>([\\\\s\\\\S]*?)</t>"))?.[1];
    const raw = body.match(new RegExp("<v[^>]*>([\\\\s\\\\S]*?)</v>"))?.[1];
    const normalized = xmlEscape(value);
    if (inline === normalized || raw === value) return rowNumber;
    const decoded = inline?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    if (decoded === value) return rowNumber;
  }
  return 0;
}

export interface SaleEditPersistenceInput {
  saleId: string;
  sellPrice: number;
  dateSold: string;
  notes?: string;
}

export function editSaleInWorkbook(workbookPath: string, input: SaleEditPersistenceInput): void {
  if (!existsSync(workbookPath)) throw new Error("Workbook not found: " + workbookPath);
  if (!Number.isFinite(input.sellPrice) || input.sellPrice < 0) throw new Error("Sell price must be a non-negative number.");
  const normalizedDateSold = input.dateSold.trim().replace(/\//g, "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDateSold)) throw new Error("Date sold must use YYYY-MM-DD.");

  const tempRoot = mkdtempSync(join(tmpdir(), "tcg-inventory-sale-edit-"));
  const unpacked = join(tempRoot, "xlsx");
  new AdmZip(workbookPath).extractAllTo(unpacked, true);
  try {
    const salesPath = join(unpacked, "xl", "worksheets", "sheet4.xml");
    const allocationPath = join(unpacked, "xl", "worksheets", "sheet5.xml");
    let salesXml = readFileSync(salesPath, "utf8");
    let allocationXml = readFileSync(allocationPath, "utf8");
    const saleRow = findSheetRowByColumnValue(salesXml, "A", input.saleId);
    if (!saleRow) throw new Error("Sale " + input.saleId + " was not found.");
    if (salesXml.includes("[VOIDED]")) {
      const saleRowXml = salesXml.match(new RegExp(String.raw`<row\b[^>]*\br="${saleRow}"[^>]*>[\s\S]*?</row>`))?.[0] ?? "";
      if (saleRowXml.includes("[VOIDED]")) throw new Error("Sale " + input.saleId + " is voided and cannot be edited.");
    }
    salesXml = replaceXmlCellValue(salesXml, "K" + saleRow, excelSerialDate(normalizedDateSold));
    salesXml = replaceXmlCellValue(salesXml, "M" + saleRow, input.sellPrice);
    salesXml = replaceXmlCellValue(salesXml, "Q" + saleRow, input.notes || "");

    const allocationRows = [...allocationXml.matchAll(new RegExp('<row\\b[^>]*\\br="(\\d+)"[^>]*>[\\s\\S]*?</row>', "g"))]
      .filter((match) => match[0].includes("<c") && new RegExp(String.raw`<c\b[^>]*\br="B${match[1]}"[^>]*>[\s\S]*?</c>`).test(match[0]) && match[0].includes(input.saleId));
    const inventory = readV2InventoryWorkbook(workbookPath);
    let totalAllocationCost = 0;
    let editedQty = 0;
    for (const match of allocationRows) {
      const row = Number(match[1]);
      const qty = Number((match[0].match(new RegExp(String.raw`<c\b[^>]*\br="E${row}"[^>]*>[\s\S]*?<v>([\s\S]*?)</v>`))?.[1] ?? "0"));
      const allocationRevenue = qty * input.sellPrice;
      const allocationCost = Number((match[0].match(new RegExp(String.raw`<c\b[^>]*\br="G${row}"[^>]*>[\s\S]*?<v>([\s\S]*?)</v>`))?.[1] ?? "0"));
      editedQty += qty;
      totalAllocationCost += Number.isFinite(allocationCost) ? allocationCost : 0;
      allocationXml = replaceXmlCellValue(allocationXml, "H" + row, allocationRevenue);
      allocationXml = replaceXmlCellValue(allocationXml, "I" + row, allocationRevenue - allocationCost);
    }

    const editedRevenue = editedQty * input.sellPrice;
    salesXml = replaceXmlFormulaCachedValue(salesXml, "N" + saleRow, editedRevenue);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "O" + saleRow, totalAllocationCost);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "P" + saleRow, editedRevenue - totalAllocationCost);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "R" + saleRow, "OK");
    for (const match of allocationRows) {
      const row = Number(match[1]);
      allocationXml = replaceXmlFormulaCachedValue(allocationXml, "L" + row, "OK");
    }
    writeFileSync(salesPath, salesXml);
    writeFileSync(allocationPath, allocationXml);
    // Preserve formula caches for Sales Log and Cost Allocations; only their input values changed.
    // Formula caches for Inventory are updated below.
    // Editing price/date does not change inventory quantities, so preserve the
    // current parsed availability values.
    const inventoryPath = join(unpacked, "xl", "worksheets", "sheet3.xml");
    let inventoryXml = readFileSync(inventoryPath, "utf8");
    for (const lot of inventory.rows) {
      const remaining = lot.remainingQty;
      const qtySold = Math.max(0, lot.qtyPurchased - remaining);
      const status = remaining === 0 ? "Sold Out" : remaining < lot.qtyPurchased ? "Partially Sold" : "In Stock";
      inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "R" + lot.sourceRow, qtySold);
      inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "S" + lot.sourceRow, remaining);
      inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "W" + lot.sourceRow, status);
    }
    writeFileSync(inventoryPath, inventoryXml);
    const output = workbookPath + ".tmp-" + process.pid + "-" + Date.now();
    packDirectory(unpacked, output);
    renameSync(output, workbookPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function rollbackSaleInWorkbook(workbookPath: string, saleId: string): void {
  if (!existsSync(workbookPath)) throw new Error("Workbook not found: " + workbookPath);
  const tempRoot = mkdtempSync(join(tmpdir(), "tcg-inventory-sale-rollback-"));
  const unpacked = join(tempRoot, "xlsx");
  new AdmZip(workbookPath).extractAllTo(unpacked, true);
  try {
    const salesPath = join(unpacked, "xl", "worksheets", "sheet4.xml");
    const allocationPath = join(unpacked, "xl", "worksheets", "sheet5.xml");
    const inventoryPath = join(unpacked, "xl", "worksheets", "sheet3.xml");
    let salesXml = readFileSync(salesPath, "utf8");
    let allocationXml = readFileSync(allocationPath, "utf8");
    let inventoryXml = readFileSync(inventoryPath, "utf8");
    const saleRow = findSheetRowByColumnValue(salesXml, "A", saleId);
    if (!saleRow) throw new Error("Sale " + saleId + " was not found.");
    const saleRowXml = salesXml.match(new RegExp(String.raw`<row\b[^>]*\br="${saleRow}"[^>]*>[\s\S]*?</row>`))?.[0] ?? "";
    if (saleRowXml.includes("[VOIDED]")) throw new Error("Sale " + saleId + " is already voided.");

    const originalQty = Number((saleRowXml.match(new RegExp(String.raw`<c\b[^>]*\br="L${saleRow}"[^>]*>[\s\S]*?<v>([\s\S]*?)</v>`))?.[1] ?? "0"));
    const originalPrice = Number((saleRowXml.match(new RegExp(String.raw`<c\b[^>]*\br="M${saleRow}"[^>]*>[\s\S]*?<v>([\s\S]*?)</v>`))?.[1] ?? "0"));
    const allocationMatches = [...allocationXml.matchAll(new RegExp('<row\\b[^>]*\\br="(\\d+)"[^>]*>[\\s\\S]*?</row>', "g"))]
      .filter((match) => match[0].includes(saleId));

    const inventory = readV2InventoryWorkbook(workbookPath);
    for (const match of allocationMatches) {
      const row = Number(match[1]);
      const inventoryId = match[0].match(new RegExp(String.raw`<c\b[^>]*\br="C${row}"[^>]*>[\s\S]*?<t[^>]*>([\s\S]*?)</t>`))?.[1]?.replace(/&amp;/g, "&") ?? "";
      const qty = Number((match[0].match(new RegExp(String.raw`<c\b[^>]*\br="E${row}"[^>]*>[\s\S]*?<v>([\s\S]*?)</v>`))?.[1] ?? "0"));
      if (inventoryId && qty > 0) {
        const lot = inventory.rows.find((candidate) => candidate.inventoryId === inventoryId);
        if (lot) {
          const remaining = Math.min(lot.qtyPurchased, lot.remainingQty + qty);
          const qtySold = lot.qtyPurchased - remaining;
          const status = remaining === lot.qtyPurchased ? "In Stock" : remaining === 0 ? "Sold Out" : "Partially Sold";
          inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "R" + lot.sourceRow, qtySold);
          inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "S" + lot.sourceRow, remaining);
          inventoryXml = replaceXmlFormulaCachedValue(inventoryXml, "W" + lot.sourceRow, status);
        }
      }
      allocationXml = replaceXmlCellValue(allocationXml, "E" + row, 0);
      allocationXml = replaceXmlCellValue(allocationXml, "G" + row, 0);
      allocationXml = replaceXmlCellValue(allocationXml, "H" + row, 0);
      allocationXml = replaceXmlCellValue(allocationXml, "I" + row, 0);
      allocationXml = replaceXmlCellValue(allocationXml, "J" + row, "VOIDED — original qty " + qty + " @ ₱" + originalPrice.toFixed(2));
    }

    const existingNotes = saleRowXml.match(new RegExp(String.raw`<c\b[^>]*\br="Q${saleRow}"[^>]*>[\s\S]*?<t[^>]*>([\s\S]*?)</t>`))?.[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") ?? "";
    const voidNote = "[VOIDED] " + (existingNotes ? existingNotes + " | " : "") + "Original quantity: " + originalQty + ". Original sell price: ₱" + originalPrice.toFixed(2) + ".";
    salesXml = replaceXmlCellValue(salesXml, "L" + saleRow, 0);
    salesXml = replaceXmlCellValue(salesXml, "Q" + saleRow, voidNote);

    // Keep the existing formula cells intact. Their cached values are updated explicitly
    // for the affected sale/allocation so the bot can read the workbook immediately.
    salesXml = replaceXmlFormulaCachedValue(salesXml, "N" + saleRow, 0);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "O" + saleRow, 0);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "P" + saleRow, 0);
    salesXml = replaceXmlFormulaCachedValue(salesXml, "R" + saleRow, "OK");
    for (const match of allocationMatches) {
      const row = Number(match[1]);
      allocationXml = replaceXmlFormulaCachedValue(allocationXml, "L" + row, "OK");
    }
    writeFileSync(salesPath, salesXml);
    writeFileSync(allocationPath, allocationXml);
    writeFileSync(inventoryPath, inventoryXml);
    const output = workbookPath + ".tmp-" + process.pid + "-" + Date.now();
    packDirectory(unpacked, output);
    renameSync(output, workbookPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
    invalidateFormulaCaches(unpacked);
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
