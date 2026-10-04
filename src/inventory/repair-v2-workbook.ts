import { existsSync, renameSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { readV2InventoryWorkbook } from "./read-xlsx.js";

const workbookPath = process.argv[2];
if (!workbookPath || !existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath ?? "(missing)"}`);

const before = readV2InventoryWorkbook(workbookPath);
if (before.issues.length) throw new Error("Refusing repair because Inventory has parser issues: " + before.issues.map(i => i.message).join(" | "));

const tempRoot = mkdtempSync(join(tmpdir(), "tcg-v2-repair-"));
const unpacked = join(tempRoot, "xlsx");
const zip = new AdmZip(workbookPath);
zip.extractAllTo(unpacked, true);

function read(rel: string) { return readFileSync(join(unpacked, rel), "utf8"); }
function write(rel: string, value: string) { writeFileSync(join(unpacked, rel), value, "utf8"); }

const workbookXml = read("xl/workbook.xml");
const relsXml = read("xl/_rels/workbook.xml.rels");
const relMap = new Map<string,string>();
for (const m of relsXml.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g)) {
  const target = m[2].replace(/^\//, "");
  relMap.set(m[1], target.startsWith("xl/") ? target : `xl/${target}`);
}
const salesRid = workbookXml.match(/<sheet[^>]+name="Sales Log"[^>]+r:id="([^"]+)"/)?.[1];
const inventoryRid = workbookXml.match(/<sheet[^>]+name="Inventory"[^>]+r:id="([^"]+)"/)?.[1];
if (!salesRid || !inventoryRid) throw new Error("Workbook is missing Inventory or Sales Log sheet.");
const salesTarget = relMap.get(salesRid)!;
const inventoryTarget = relMap.get(inventoryRid)!;

function replaceCellFormula(xml: string, ref: string, formula: string): string {
  const pattern = new RegExp(`<c\\b([^>]*\\br="${ref}"[^>]*)>[\\s\\S]*?<\\/c>`);
  const replacement = `<c r="${ref}" s="16" t="str"><f>${formula}</f><v></v></c>`;
  if (!pattern.test(xml)) throw new Error(`Missing cell ${ref}`);
  return xml.replace(pattern, replacement);
}

let salesXml = read(salesTarget);
for (let row = 4; row <= 5000; row++) {
  if (!new RegExp(`<c\\b[^>]*\\br="B${row}"[^>]*>`).test(salesXml)) continue;
  salesXml = replaceCellFormula(
    salesXml,
    `B${row}`,
    `IF(D${row}="","",IFERROR(INDEX(Inventory!$B$4:$B$5000,MATCH(C${row},Inventory!$A$4:$A$5000,0)),"ID NOT FOUND"))`,
  );
}
write(salesTarget, salesXml);

// Reassert the complete inventory calculation chain for every existing lot.
// This prevents Qty Sold/Remaining Qty from updating while revenue, cost,
// profit/loss, average sell price, and stock status remain stale.
let inventoryXml = read(inventoryTarget);
for (const row of before.rows) {
  const formulas: Record<string, string> = {
    Q: `IF(A${row.sourceRow}="","",IF(R${row.sourceRow}=0,"",T${row.sourceRow}/R${row.sourceRow}))`,
    R: `IF(A${row.sourceRow}="","",SUMIFS('Cost Allocations'!$E$4:$E$5000,'Cost Allocations'!$C$4:$C$5000,A${row.sourceRow}))`,
    S: `IF(A${row.sourceRow}="","",M${row.sourceRow}-R${row.sourceRow})`,
    T: `IF(A${row.sourceRow}="","",SUMIFS('Cost Allocations'!$H$4:$H$5000,'Cost Allocations'!$C$4:$C$5000,A${row.sourceRow}))`,
    U: `IF(A${row.sourceRow}="","",SUMIFS('Cost Allocations'!$G$4:$G$5000,'Cost Allocations'!$C$4:$C$5000,A${row.sourceRow}))`,
    V: `IF(A${row.sourceRow}="","",T${row.sourceRow}-U${row.sourceRow})`,
    W: `IF(A${row.sourceRow}="","",IF(X${row.sourceRow}<>"",X${row.sourceRow},IF(S${row.sourceRow}<0,"Over-Allocated",IF(S${row.sourceRow}=0,"Sold Out",IF(R${row.sourceRow}=0,"In Stock","Partially Sold")))))`,
  };
  for (const [column, formula] of Object.entries(formulas)) {
    inventoryXml = replaceCellFormula(inventoryXml, `${column}${row.sourceRow}`, formula);
  }
}
write(inventoryTarget, inventoryXml);

// Cost Allocations uses the selected inventory lot as the acquisition-cost
// source. "Selected Lot" is therefore the honest method label; this is not a
// global FIFO allocator. A future FIFO mode can allocate one sale across
// multiple lots and create multiple allocation rows.
const allocationRid = workbookXml.match(/<sheet[^>]+name="Cost Allocations"[^>]+r:id="([^"]+)"/)?.[1];
const allocationTarget = allocationRid ? relMap.get(allocationRid) : undefined;
if (allocationTarget) {
  let allocationXml = read(allocationTarget);
  for (let row = 4; row <= 5000; row++) {
    if (!new RegExp(`<c\\b[^>]*\\br="A${row}"[^>]*>`).test(allocationXml)) continue;
    allocationXml = replaceCellFormula(allocationXml, `D${row}`, `IF(A${row}="","",IFERROR(INDEX(Inventory!$B$4:$B$5000,MATCH(C${row},Inventory!$A$4:$A$5000,0)),"ID NOT FOUND"))`);
    allocationXml = replaceCellFormula(allocationXml, `F${row}`, `IF(A${row}="","",IFERROR(INDEX(Inventory!$N$4:$N$5000,MATCH(C${row},Inventory!$A$4:$A$5000,0)),0))`);
    allocationXml = replaceCellFormula(allocationXml, `G${row}`, `IF(A${row}="","",E${row}*F${row})`);
    allocationXml = replaceCellFormula(allocationXml, `H${row}`, `IF(A${row}="","",E${row}*IFERROR(INDEX('Sales Log'!$M$4:$M$5000,MATCH(B${row},'Sales Log'!$A$4:$A$5000,0)),0))`);
    allocationXml = replaceCellFormula(allocationXml, `I${row}`, `IF(A${row}="","",H${row}-G${row})`);
    allocationXml = replaceCellFormula(allocationXml, `L${row}`, `IF(A${row}="","",IF(D${row}="ID NOT FOUND","BAD INV ID",IF(ISNA(MATCH(B${row},'Sales Log'!$A$4:$A$5000,0)),"BAD SALE ID",IF(INDEX('Sales Log'!$B$4:$B$5000,MATCH(B${row},'Sales Log'!$A$4:$A$5000,0))=D${row},"OK","KEY MISMATCH"))))`);
  }
  write(allocationTarget, allocationXml);
}

let wb = workbookXml;
if (/<calcPr\b[^>]*\/>/.test(wb)) {
  wb = wb.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
} else if (/<\/workbook>/.test(wb)) {
  wb = wb.replace("</workbook>", '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
}
write("xl/workbook.xml", wb);

const repairedPath = workbookPath + ".repaired";
const outZip = new AdmZip();
function addDir(dir: string, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDir(full, name);
    else outZip.addFile(name, readFileSync(full));
  }
}
addDir(unpacked);
outZip.writeZip(repairedPath);
renameSync(repairedPath, workbookPath);

const after = readV2InventoryWorkbook(workbookPath);
if (after.issues.length) throw new Error("Repaired workbook failed parser validation: " + after.issues.map(i => i.message).join(" | "));
console.log(JSON.stringify({ workbook: workbookPath, inventoryRows: after.rows.length, repaired: true }));
