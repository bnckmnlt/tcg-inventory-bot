import assert from "node:assert/strict";
import test from "node:test";
import { calculateCardSalesTotals, calculateSalesTotal, formatSalesTotalExport } from "./sales-total.js";
import type { SaleManagementRecord } from "./sale-management.js";

function sale(overrides: Partial<SaleManagementRecord> = {}): SaleManagementRecord {
  return {
    saleId: "SALE-000001",
    inventoryId: "INV-000001",
    cardName: "Pikachu",
    setSeries: "SV",
    cardNumber: "001",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    dateSold: "2026-08-17",
    qtySold: 2,
    sellPrice: 150,
    revenue: 300,
    cost: 200,
    profit: 100,
    voided: false,
    ...overrides,
  };
}

test("adds revenue, cost, profit, cards and transactions for all non-voided sales", () => {
  const sales = [
    sale(),
    sale({ saleId: "SALE-000002", dateSold: "2026-09-05", qtySold: 1, revenue: 400, cost: 250, profit: 150 }),
    sale({ saleId: "SALE-000003", dateSold: undefined, qtySold: 3, revenue: 120, cost: 90, profit: 30 }),
    sale({ saleId: "SALE-000004", voided: true, qtySold: 1, revenue: 1000, cost: 10, profit: 990 }),
    sale({ saleId: "SALE-000005", qtySold: 0, revenue: 1000, cost: 10, profit: 990 }),
  ];

  assert.deepEqual(calculateSalesTotal(sales), {
    transactions: 3, cardsSold: 6, revenue: 820, cost: 540, profit: 280,
  });
});

test("filters sale dates inclusively without attributing undated sales to neighboring records", () => {
  const sales = [
    sale({ dateSold: "2026-05-23" }),
    sale({ dateSold: undefined, revenue: 1000 }),
    sale({ dateSold: "2026-08-17", qtySold: 1, revenue: 200, cost: 120, profit: 80 }),
    sale({ dateSold: "2026-08-31", qtySold: 1, revenue: 250, cost: 150, profit: 100 }),
    sale({ dateSold: "2026-09-01" }),
    sale({ dateSold: "2026-08-22", voided: true, revenue: 900 }),
  ];

  assert.deepEqual(calculateSalesTotal(sales, "2026-08-17", "2026-08-31"), {
    transactions: 2, cardsSold: 2, revenue: 450, cost: 270, profit: 180,
  });
});

test("reports zeros for ranges with no matching sales", () => {
  assert.deepEqual(calculateSalesTotal([sale()], "2026-01-01", "2026-01-31"), {
    transactions: 0, cardsSold: 0, revenue: 0, cost: 0, profit: 0,
  });
});

test("groups repeat sales of the same card and explains their combined costs and revenue", () => {
  const sales = [
    sale({ saleId: "SALE-000001", qtySold: 2, revenue: 300, cost: 200, profit: 100 }),
    sale({ saleId: "SALE-000002", inventoryId: "INV-000002", dateSold: "2026-08-18", qtySold: 1, revenue: 300, cost: 150, profit: 150 }),
    sale({ saleId: "SALE-000003", dateSold: "2026-08-18", qtySold: 1, revenue: 500, cost: 100, profit: 400, voided: true }),
    sale({ saleId: "SALE-000004", dateSold: "2026-09-01", qtySold: 1, revenue: 100, cost: 70, profit: 30 }),
  ];

  const cards = calculateCardSalesTotals(sales, "2026-08-17", "2026-08-31");
  assert.deepEqual(cards, [{
    cardName: "Pikachu", setSeries: "SV", cardNumber: "001", rarity: undefined,
    condition: "Near Mint", language: "English", variantPrinting: "Normal",
    transactions: 2, qtySold: 3, revenue: 600, cost: 350, profit: 250,
  }]);

  const report = formatSalesTotalExport(sales, "2026-08-17", "2026-08-31");
  assert.match(report, /Revenue:      ₱600\.00/);
  assert.match(report, /Card cost:    ₱350\.00/);
  assert.match(report, /Profit\/Loss:  ₱250\.00/);
  assert.match(report, /Pikachu 001  x3/);
  assert.match(report, /Cost:  ₱350\.00 \(avg ₱116\.67\/card\)/);
  assert.match(report, /Sales: ₱600\.00 \(avg ₱200\.00\/card\)/);
  assert.match(report, /P\/L:   ₱250\.00/);
  assert.doesNotMatch(report, /₱500\.00/);
});

test("keeps different card printings and conditions separate in two aligned export columns", () => {
  const records = [
    sale({ cardName: "A very long Pikachu card name", cardNumber: "123/999", setSeries: "SV", qtySold: 2, revenue: 200, cost: 120, profit: 80 }),
    sale({ cardName: "Bulbasaur", cardNumber: "001/165", setSeries: "SV", qtySold: 1, revenue: 30, cost: 40, profit: -10 }),
    sale({ cardName: "Charmander", cardNumber: "004/165", setSeries: "SV", qtySold: 3, revenue: 300, cost: 180, profit: 120 }),
    sale({ cardName: "Charmander", cardNumber: "004/165", condition: "Played", setSeries: "SV", qtySold: 1, revenue: 50, cost: 30, profit: 20 }),
  ];
  const output = formatSalesTotalExport(records);
  assert.equal(calculateCardSalesTotals(records).length, 4);
  const titleLines = output.split("\n").filter((line) => / x\d/.test(line));
  assert.equal(titleLines.length, 2);
  assert.match(titleLines[0], /A very long Pikachu card name 123\/999  x2\s+Charmander 004\/165  x3/);
  assert.match(titleLines[1], /Bulbasaur 001\/165  x1\s+Charmander 004\/165  x1/);

  const rightColumnOffsets = titleLines.map((line) => line.indexOf("Charmander"));
  assert.equal(rightColumnOffsets[0], rightColumnOffsets[1]);
  assert.match(output, /Card cost:    ₱370\.00/);
  assert.match(output, /Profit\/Loss:  ₱210\.00/);
});

test("empty sales produce an explicit empty card breakdown", () => {
  const report = formatSalesTotalExport([sale({ voided: true })]);
  assert.match(report, /Transactions: 0/);
  assert.match(report, /CARD BREAKDOWN\n\(none\)/);
});
