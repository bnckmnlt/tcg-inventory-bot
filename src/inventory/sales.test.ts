import test from "node:test";
import assert from "node:assert/strict";
import { buildSelectedLotSalePlan, buildSaleCardKey, searchInventoryRows } from "./sales.js";
import type { ParsedV2InventoryRow } from "./v2-workbook.js";

function lot(overrides: Partial<ParsedV2InventoryRow>): ParsedV2InventoryRow {
  return {
    sourceRow: 4,
    rawCardKey: "CHARIZARD|SV01|006|RARE|NEAR MINT|ENGLISH|HOLOFOIL",
    inventoryId: "INV-000001",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    remainingQty: 5,
    qtyPurchased: 5,
    unitCost: 50,
    raw: {},
    ...overrides,
  };
}

test("sale search matches across identity fields and excludes sold-out lots", () => {
  const rows = [
    lot({ inventoryId: "INV-000001" }),
    lot({ inventoryId: "INV-000002", remainingQty: 0 }),
    lot({ inventoryId: "INV-000003", cardName: "Pikachu", rawCardKey: "PIKACHU|SV01|025|COMMON|NEAR MINT|ENGLISH|NORMAL" }),
  ];
  assert.deepEqual(searchInventoryRows(rows, "charizard 006" ).map((row) => row.inventoryId), ["INV-000001"]);
  assert.deepEqual(searchInventoryRows(rows, "pikachu").map((row) => row.inventoryId), ["INV-000003"]);
});

test("sale allocation uses the selected inventory lot rather than global FIFO", () => {
  const rows = [
    lot({ inventoryId: "INV-000010", remainingQty: 3, unitCost: 900, purchaseDate: "2026-09-01" }),
    lot({ inventoryId: "INV-000002", remainingQty: 2, unitCost: 50, purchaseDate: undefined }),
    lot({ inventoryId: "INV-000003", remainingQty: 5, unitCost: 60, purchaseDate: "2026-08-01" }),
  ];
  const draft = {
    cardKey: rows[0].rawCardKey,
    inventoryId: "INV-000010",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    dateSold: "2026-10-02",
    qtySold: 2,
    sellPrice: 1000,
  };
  const plan = buildSelectedLotSalePlan(rows, draft, ["SALE-000020"]);
  assert.equal(plan.saleId, "SALE-000021");
  assert.deepEqual(plan.allocations, [{ inventoryId: "INV-000010", qty: 2, unitCost: 900 }]);
});

test("a selected inventory lot can be sold in multiple transactions at different prices", () => {
  const rows = [lot({ inventoryId: "INV-000010", remainingQty: 10, unitCost: 900 })];
  const firstSale = buildSelectedLotSalePlan(rows, {
    cardKey: rows[0].rawCardKey,
    inventoryId: "INV-000010",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    dateSold: "2026-10-02",
    qtySold: 5,
    sellPrice: 150,
  }, []);
  const secondSale = buildSelectedLotSalePlan(rows, {
    cardKey: rows[0].rawCardKey,
    inventoryId: "INV-000010",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    dateSold: "2026-10-03",
    qtySold: 5,
    sellPrice: 300,
  }, ["SALE-000001"]);
  assert.deepEqual(firstSale.allocations, [{ inventoryId: "INV-000010", qty: 5, unitCost: 900 }]);
  assert.deepEqual(secondSale.allocations, [{ inventoryId: "INV-000010", qty: 5, unitCost: 900 }]);
  assert.equal(firstSale.saleId, "SALE-000001");
  assert.equal(secondSale.saleId, "SALE-000002");
});

test("selected lot quantity cannot be exceeded", () => {
  const rows = [lot({ inventoryId: "INV-000010", remainingQty: 2, unitCost: 900 })];
  assert.throws(() => buildSelectedLotSalePlan(rows, {
    cardKey: rows[0].rawCardKey,
    inventoryId: "INV-000010",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    dateSold: "2026-10-02",
    qtySold: 3,
    sellPrice: 1000,
  }, []), /Only 2 unit\(s\) remain in the selected inventory lot/);
});

test("sale card key follows the workbook seven-field identity", () => {
  const key = buildSaleCardKey({
    cardKey: "",
    inventoryId: "INV-000001",
    cardName: "Charizard",
    setSeries: "SV01",
    cardNumber: "006",
    rarity: "Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Holofoil",
    dateSold: "2026-10-02",
    qtySold: 1,
    sellPrice: 150,
  });
  assert.equal(key, "CHARIZARD|SV01|006|RARE|NEAR MINT|ENGLISH|HOLOFOIL");
});
