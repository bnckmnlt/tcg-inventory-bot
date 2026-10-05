import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvoiceData } from "../extract.js";
import { appendInventoryRowsToWorkbook, invoicePlanToWorkbookRows, persistSaleToWorkbook, readWorkbookIds } from "./workbook-persistence.js";
import type { IngestionPlan } from "./ingest.js";
import type { V2InventoryRow } from "./types.js";
import { readV2InventoryWorkbook } from "./read-xlsx.js";

function workbookRow(overrides: Partial<V2InventoryRow> = {}): V2InventoryRow {
  return {
    inventoryId: "IMG-ORDER-1-001",
    cardName: "Pikachu",
    setSeries: "Test Set",
    cardNumber: "001",
    rarity: "Common",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    purchaseDate: "2026-09-30",
    seller: "Test Seller",
    orderId: "ORDER-1",
    qtyPurchased: 2,
    unitCost: 1.25,
    totalCost: 2.5,
    remainingQty: 2,
    ...overrides,
  };
}

function inventorySheetXml(path: string): string {
  return new AdmZip(path).readAsText("xl/worksheets/sheet3.xml");
}

test("reads Sale and Allocation IDs after local sale persistence", () => {
  const source = join(process.cwd(), "clean-inventory.xlsx");
  withTempRoot((root) => {
    const workbook = join(root, "inventory.xlsx");
    appendInventoryRowsToWorkbook(source, workbook, [workbookRow()], { unitCostRate: 1 });
    persistSaleToWorkbook(workbook, {
      saleId: "SALE-000001",
      cardKey: "PIKACHU|TEST SET|001|COMMON|NEAR MINT|ENGLISH|NORMAL",
      inventoryId: "IMG-ORDER-1-001",
      cardName: "Pikachu",
      setSeries: "Test Set",
      cardNumber: "001",
      rarity: "Common",
      condition: "Near Mint",
      language: "English",
      variantPrinting: "Normal",
      dateSold: "2026-10-01",
      qtySold: 1,
      sellPrice: 2,
      allocations: [{ allocationId: "ALLOC-000001", inventoryId: "IMG-ORDER-1-001", qty: 1 }],
    });

    assert.deepEqual(readWorkbookIds(workbook, 4, "SALE"), ["SALE-000001"]);
    assert.deepEqual(readWorkbookIds(workbook, 5, "ALLOC"), ["ALLOC-000001"]);
  });
});

function dashboardSheetXml(path: string): string {
  return new AdmZip(path).readAsText("xl/worksheets/sheet1.xml");
}

function rowXml(xml: string, rowNumber: number): string {
  const match = xml.match(new RegExp(`<row r="${rowNumber}"[^>]*>[\\s\\S]*?<\\/row>`));
  assert.ok(match, `Expected Inventory row ${rowNumber}.`);
  return match[0];
}

function styleMap(xml: string, rowNumber: number): Map<string, string> {
  const row = rowXml(xml, rowNumber);
  const styles = new Map<string, string>();
  for (const match of row.matchAll(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const attrs = match[1] ?? "";
    const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
    const style = attrs.match(/s="(\d+)"/)?.[1];
    if (ref && style) styles.set(ref, style);
  }
  return styles;
}

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tcg-workbook-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invoice: InvoiceData = {
  seller: "Test Seller",
  purchaseDate: "2026-09-30",
  orderId: "ORDER-1",
  subtotal: 10,
  shipping: 0,
  tax: 0,
  total: 10,
  currency: "USD",
  uncertainFields: [],
  lineItems: [],
};

function plan(inputOverrides: Partial<IngestionPlan["rows"][number]["input"]>): IngestionPlan {
  const input = {
    inventoryId: "IMG-ORDER-1-001",
    cardName: "Pikachu",
    setSeries: "Test Set",
    cardNumber: "001",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 2,
    qtyPurchased: 2,
    unitCost: 1.25,
    totalCost: 2.5,
    ...inputOverrides,
  };

  return {
    rows: [{
      ingestionKey: "ORDER-1:line:1",
      sourceMessageId: "ORDER-1",
      sourceLine: 1,
      action: "INSERT",
      state: input.resolutionState ?? "INCOMPLETE",
      inventoryId: input.inventoryId,
      input,
      skuId: input.skuId,
      reasons: input.resolutionReasons ?? [],
    }],
    insertable: 1,
    pendingReview: 0,
    skipped: 0,
  };
}

test("inserts the first card into row 4 of a clean starter workbook and preserves formatting", () => {
  const source = join(process.cwd(), "clean-inventory.xlsx");
  withTempRoot((root) => {
    const output = join(root, "clean-with-card.xlsx");
    const sourceXml = inventorySheetXml(source);

    appendInventoryRowsToWorkbook(source, output, [workbookRow()], { unitCostRate: 1 });

    const result = readV2InventoryWorkbook(output);
    assert.equal(result.issues.length, 0);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].sourceRow, 4);
    assert.equal(result.rows[0].inventoryId, "IMG-ORDER-1-001");

    const outputXml = inventorySheetXml(output);
    assert.equal(rowXml(outputXml, 1), rowXml(sourceXml, 1));
    assert.equal(rowXml(outputXml, 2), rowXml(sourceXml, 2));
    assert.equal(rowXml(outputXml, 3), rowXml(sourceXml, 3));
    assert.deepEqual(styleMap(outputXml, 4), styleMap(sourceXml, 49));
    assert.deepEqual(styleMap(outputXml, 5), styleMap(sourceXml, 5));

    const sourceDashboardXml = dashboardSheetXml(source);
    const sourceDashboardA6 = sourceDashboardXml.match(/<c r="A6"[^>]*>/)?.[0];
    assert.ok(sourceDashboardA6);

    const dashboardXml = dashboardSheetXml(output);
    assert.ok(dashboardXml.includes(sourceDashboardA6 + '<f>SUM(Inventory!$M$4:$M$5000)</f></c>'));
    assert.ok(!dashboardXml.includes(sourceDashboardA6 + '<f>SUM(Inventory!$M$4:$M$5000)</f><v>'))
  });
});

test("appends after the last actual card instead of resetting to row 4", () => {
  const source = join(process.cwd(), "clean-inventory.xlsx");
  withTempRoot((root) => {
    const firstOutput = join(root, "first.xlsx");
    const secondOutput = join(root, "second.xlsx");
    const first = workbookRow({ inventoryId: "IMG-ORDER-1-001" });
    const second = workbookRow({ inventoryId: "IMG-ORDER-1-002", cardNumber: "002" });

    appendInventoryRowsToWorkbook(source, firstOutput, [first], { unitCostRate: 1 });
    appendInventoryRowsToWorkbook(firstOutput, secondOutput, [second], { unitCostRate: 1 });

    const result = readV2InventoryWorkbook(secondOutput);
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.rows.map((row) => [row.sourceRow, row.inventoryId]), [
      [4, "IMG-ORDER-1-001"],
      [5, "IMG-ORDER-1-002"],
    ]);

    const xml = inventorySheetXml(secondOutput);
    assert.match(rowXml(xml, 4), /r="A4"[^>]*>.*IMG-ORDER-1-001/s);
    assert.match(rowXml(xml, 5), /r="A5"[^>]*>.*IMG-ORDER-1-002/s);
    assert.deepEqual(styleMap(xml, 5), styleMap(inventorySheetXml(source), 49));
  });
});

test("preserves sold-out inventory caches across sequential sales", () => {
  const source = join(process.cwd(), "clean-inventory.xlsx");
  withTempRoot((root) => {
    const workbook = join(root, "inventory.xlsx");
    const first = workbookRow({ inventoryId: "IMG-ORDER-1-001", cardNumber: "001", qtyPurchased: 2, remainingQty: 2 });
    const second = workbookRow({ inventoryId: "IMG-ORDER-1-002", cardNumber: "002", qtyPurchased: 2, remainingQty: 2 });

    appendInventoryRowsToWorkbook(source, workbook, [first, second], { unitCostRate: 1 });

    const saleInput = (inventoryId: string, cardNumber: string, saleId: string, allocationId: string) => ({
      saleId,
      cardKey: "PIKACHU|TEST SET|" + cardNumber + "|COMMON|NEAR MINT|ENGLISH|NORMAL",
      inventoryId,
      cardName: "Pikachu",
      setSeries: "Test Set",
      cardNumber,
      rarity: "Common",
      condition: "Near Mint",
      language: "English",
      variantPrinting: "Normal",
      dateSold: "2026-10-01",
      qtySold: 2,
      sellPrice: 2,
      allocations: [{ allocationId, inventoryId, qty: 2 }],
    });

    persistSaleToWorkbook(workbook, saleInput("IMG-ORDER-1-001", "001", "SALE-000001", "ALLOC-000001"));
    persistSaleToWorkbook(workbook, saleInput("IMG-ORDER-1-002", "002", "SALE-000002", "ALLOC-000002"));

    const result = readV2InventoryWorkbook(workbook);
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.rows.map((row) => [row.inventoryId, row.remainingQty]), [
      ["IMG-ORDER-1-001", 0],
      ["IMG-ORDER-1-002", 0],
    ]);
  });
});

test("converts invoice unit costs into workbook currency without changing quantity", () => {
  const rows = invoicePlanToWorkbookRows(plan({}), invoice, { unitCostRate: 57.5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unitCost, 1.25);
  assert.equal(rows[0].qtyPurchased, 2);
  assert.equal(rows[0].totalCost, 143.75);
});

test("keeps review metadata and unresolved SKU state on workbook rows", () => {
  const rows = invoicePlanToWorkbookRows(
    plan({
      resolutionState: "INCOMPLETE",
      resolutionReasons: ["Stable identity; SKU unavailable."],
      reviewRequired: true,
      reviewFlags: ["CARD_NAME_UNCERTAIN", "QUANTITY_UNCERTAIN"],
      reviewNotes: ["Product name is difficult to read.", "Quantity is unclear."],
    }),
    invoice,
    { unitCostRate: 57.5 },
  );

  assert.deepEqual(rows[0].reviewFlags, ["CARD_NAME_UNCERTAIN", "QUANTITY_UNCERTAIN"]);
  assert.deepEqual(rows[0].reviewNotes, ["Product name is difficult to read.", "Quantity is unclear."]);
  assert.equal(rows[0].skuId, undefined);
  assert.equal(rows[0].resolutionState, "INCOMPLETE");
});

test("skips non-insert plan rows when preparing workbook persistence", () => {
  const base = plan({});
  base.rows.push({
    ...base.rows[0],
    ingestionKey: "ORDER-1:line:2",
    sourceLine: 2,
    action: "SKIP",
    input: { ...base.rows[0].input, inventoryId: "IMG-ORDER-1-002" },
  });
  base.insertable = 1;
  base.skipped = 1;

  const rows = invoicePlanToWorkbookRows(base, invoice, { unitCostRate: 57.5 });
  assert.deepEqual(rows.map((row) => row.inventoryId), ["IMG-ORDER-1-001"]);
});
