import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readV2InventoryWorkbook } from "./read-xlsx.js";

interface Cell { value: string | number; formula?: string; }
type Sheet = Record<string, Cell>[];

function unzip(path: string, entry: string): string {
  return execFileSync("unzip", ["-p", path, entry], { encoding: "utf8" });
}

function decode(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function sharedStrings(path: string): string[] {
  try {
    const xml = unzip(path, "xl/sharedStrings.xml");
    return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join(""),
    );
  } catch { return []; }
}

function sheetTargets(path: string): Map<string, string> {
  const workbook = unzip(path, "xl/workbook.xml");
  const rels = unzip(path, "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g)) {
    const target = m[2].replace(/^\//, "");
    relMap.set(m[1], target.startsWith("xl/") ? target : `xl/${target}`);
  }
  const out = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\s+([^>]+?)\s*\/>/g)) {
    const attrs = m[1];
    const name = attrs.match(/name="([^"]+)"/)?.[1];
    const rid = attrs.match(/r:id="([^"]+)"/)?.[1];
    if (name && rid && relMap.has(rid)) out.set(decode(name), relMap.get(rid)!);
  }
  return out;
}

function readSheet(path: string, target: string, strings: string[]): Sheet {
  const xml = unzip(path, target);
  const rows: Sheet = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Record<string, Cell> = {};
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? "";
      const ref = attrs.match(/r="([^"]+)"/)?.[1];
      if (!ref) continue;
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const raw = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const formula = body.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1];
      const inline = type === "inlineStr" ? body.match(/<is[^>]*>([\s\S]*?)<\/is>/)?.[1]?.replace(/<[^>]+>/g, "") ?? "" : "";
      let value: string | number = inline ? decode(inline) : raw;
      if (type === "s") value = Number.isInteger(Number(raw)) ? strings[Number(raw)] ?? "" : "";
      else if (type !== "str" && type !== "inlineStr" && raw !== "") {
        const n = Number(raw); value = Number.isFinite(n) ? n : raw;
      }
      row[ref.replace(/\d+$/, "")] = { value, ...(formula ? { formula: decode(formula) } : {}) };
    }
    rows.push(row);
  }
  return rows;
}

function num(sheet: Sheet, row: number, col: string): number | null {
  const v = sheet[row - 1]?.[col]?.value;
  return typeof v === "number" ? v : Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : null;
}
function str(sheet: Sheet, row: number, col: string): string {
  const v = sheet[row - 1]?.[col]?.value;
  return v == null ? "" : String(v).trim();
}

const path = process.argv[2];
if (!path || !existsSync(path)) throw new Error(`Workbook not found: ${path ?? "(missing path)"}`);

const parsed = readV2InventoryWorkbook(path);
const strings = sharedStrings(path);
const targets = sheetTargets(path);
const sales = readSheet(path, targets.get("Sales Log")!, strings);
const alloc = readSheet(path, targets.get("Cost Allocations")!, strings);

const issues: Array<Record<string, unknown>> = [];
const warn = (type: string, detail: Record<string, unknown>) => issues.push({ type, ...detail });

const invIds = new Map<string, number>();
for (const row of parsed.rows) {
  invIds.set(row.inventoryId, (invIds.get(row.inventoryId) ?? 0) + 1);
  if (row.qtyPurchased < 0) warn("NEGATIVE_PURCHASE_QTY", { inventoryId: row.inventoryId, qtyPurchased: row.qtyPurchased });
  if (row.remainingQty < 0) warn("NEGATIVE_REMAINING_QTY", { inventoryId: row.inventoryId, remainingQty: row.remainingQty });
  if (row.remainingQty > row.qtyPurchased) warn("REMAINING_GT_PURCHASED", { inventoryId: row.inventoryId, qtyPurchased: row.qtyPurchased, remainingQty: row.remainingQty });
}
for (const [inventoryId, count] of invIds) if (count > 1) warn("DUPLICATE_INVENTORY_ID", { inventoryId, count });

const salesById = new Map<string, number>();
for (let r = 4; r <= sales.length; r++) {
  const id = str(sales, r, "A"); if (!id) continue;
  salesById.set(id, (salesById.get(id) ?? 0) + 1);
  const qty = num(sales, r, "L");
  const check = str(sales, r, "R");
  if (qty == null || qty <= 0) warn("INVALID_SALE_QTY", { row: r, saleId: id, qty });
  if (check && check !== "OK") warn("SALE_ALLOCATION_CHECK", { row: r, saleId: id, check });
}
for (const [saleId, count] of salesById) if (count > 1) warn("DUPLICATE_SALE_ID", { saleId, count });

const allocBySale = new Map<string, { qty: number; revenue: number; rows: number[] }>();
const allocByInv = new Map<string, { qty: number; rows: number[] }>();
for (let r = 4; r <= alloc.length; r++) {
  const id = str(alloc, r, "A"); if (!id) continue;
  const saleId = str(alloc, r, "B");
  const invId = str(alloc, r, "C");
  const qty = num(alloc, r, "E") ?? 0;
  const revenue = num(alloc, r, "H") ?? 0;
  const a = allocBySale.get(saleId) ?? { qty: 0, revenue: 0, rows: [] };
  a.qty += qty; a.revenue += revenue; a.rows.push(r); allocBySale.set(saleId, a);
  const b = allocByInv.get(invId) ?? { qty: 0, rows: [] };
  b.qty += qty; b.rows.push(r); allocByInv.set(invId, b);
  if (!invIds.has(invId)) warn("ORPHAN_ALLOCATION_INVENTORY", { row: r, allocationId: id, inventoryId: invId, saleId });
  if (!salesById.has(saleId)) warn("ORPHAN_ALLOCATION_SALE", { row: r, allocationId: id, inventoryId: invId, saleId });
  if (qty <= 0) warn("INVALID_ALLOCATION_QTY", { row: r, allocationId: id, qty });
  const allocationCheck = str(alloc, r, "L");
  if (allocationCheck && allocationCheck !== "OK") warn("ALLOCATION_KEY_CHECK", { row: r, allocationId: id, saleId, inventoryId: invId, check: allocationCheck });
}

for (let r = 4; r <= sales.length; r++) {
  const saleId = str(sales, r, "A"); if (!saleId) continue;
  const saleQty = num(sales, r, "L") ?? 0;
  const saleRevenue = num(sales, r, "N") ?? 0;
  const a = allocBySale.get(saleId) ?? { qty: 0, revenue: 0, rows: [] };
  if (Math.abs(a.qty - saleQty) > 1e-9) warn("SALE_QTY_MISMATCH", { row: r, saleId, saleQty, allocatedQty: a.qty, allocationRows: a.rows });
  if (Math.abs(a.revenue - saleRevenue) > 0.01) warn("SALE_REVENUE_MISMATCH", { row: r, saleId, saleRevenue, allocatedRevenue: a.revenue, allocationRows: a.rows });
}

for (const row of parsed.rows) {
  const a = allocByInv.get(row.inventoryId) ?? { qty: 0, rows: [] };
  const expectedSold = row.qtyPurchased - row.remainingQty;
  if (Math.abs(a.qty - expectedSold) > 1e-9) warn("INVENTORY_QTY_RECONCILIATION", { inventoryId: row.inventoryId, qtyPurchased: row.qtyPurchased, remainingQty: row.remainingQty, expectedSold, allocatedSold: a.qty, allocationRows: a.rows });
  if (a.qty > row.qtyPurchased + 1e-9) warn("OVER_ALLOCATED_INVENTORY", { inventoryId: row.inventoryId, qtyPurchased: row.qtyPurchased, allocatedQty: a.qty, allocationRows: a.rows });
}

const zeroStock = parsed.rows.filter((r) => r.remainingQty === 0).length;
const positiveStock = parsed.rows.filter((r) => r.remainingQty > 0).length;
const totalPurchased = parsed.rows.reduce((s, r) => s + r.qtyPurchased, 0);
const totalRemaining = parsed.rows.reduce((s, r) => s + r.remainingQty, 0);
const totalAllocated = [...allocByInv.values()].reduce((s, a) => s + a.qty, 0);
const totalSalesQty = [...allocBySale.values()].reduce((s, a) => s + a.qty, 0);
const totalSalesRevenue = [...allocBySale.values()].reduce((s, a) => s + a.revenue, 0);

console.log(JSON.stringify({
  workbook: path,
  parsedInventoryRows: parsed.rows.length,
  parserIssues: parsed.issues,
  salesRows: [...salesById.values()].reduce((a,b)=>a+b,0),
  uniqueSales: salesById.size,
  allocationRows: [...allocBySale.values()].reduce((s,a)=>s+a.rows.length,0),
  uniqueInventoryIds: invIds.size,
  totals: { totalPurchased, totalRemaining, impliedSold: totalPurchased-totalRemaining, allocatedSold: totalAllocated, salesQtyAllocated: totalSalesQty, totalSalesRevenue, zeroStockLots: zeroStock, positiveStockLots: positiveStock },
  issueCount: issues.length,
  issues,
}, null, 2));
