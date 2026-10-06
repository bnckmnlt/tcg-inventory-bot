import assert from "node:assert/strict";
import test from "node:test";
import { findInventoryAvailability } from "./availability.js";
import type { ParsedV2InventoryRow } from "./v2-workbook.js";

function row(overrides: Partial<ParsedV2InventoryRow> = {}): ParsedV2InventoryRow {
  return {
    sourceRow: 4,
    rawCardKey: "",
    inventoryId: "INV-1",
    cardName: "Pikachu",
    setSeries: "Base Set",
    cardNumber: "025",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 1,
    qtyPurchased: 1,
    unitCost: 100,
    raw: {},
    ...overrides,
  };
}

test("includes in-stock lots purchased before or during the requested range", () => {
  const result = findInventoryAvailability(
    [row({ inventoryId: "INV-1", purchaseDate: "2026-09-15" })],
    [],
    "2026-10-01",
    "2026-10-31",
  );

  assert.deepEqual(result.inStock.map((item) => item.row.inventoryId), ["INV-1"]);
  assert.equal(result.inStock[0].dateBasis, "PURCHASE_DATE");
});

test("excludes stock purchased after the requested range", () => {
  const result = findInventoryAvailability(
    [row({ purchaseDate: "2026-11-01" })],
    [],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.inStock.length, 0);
});

test("uses the latest sale date as the sold-out end boundary", () => {
  const result = findInventoryAvailability(
    [row({ inventoryId: "INV-2", remainingQty: 0, purchaseDate: "2026-09-01" })],
    [
      { inventoryId: "INV-2", dateSold: "2026-10-10", qtySold: 1 },
      { inventoryId: "INV-2", dateSold: "2026-10-15", qtySold: 1 },
    ],
    "2026-10-12",
    "2026-10-31",
  );

  assert.equal(result.soldOut.length, 1);
  assert.equal(result.soldOut[0].endDate, "2026-10-15");
});

test("excludes sold-out lots whose last sale was before the range", () => {
  const result = findInventoryAvailability(
    [row({ remainingQty: 0, purchaseDate: "2026-08-01" })],
    [{ inventoryId: "INV-1", dateSold: "2026-09-30", qtySold: 1 }],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.soldOut.length, 0);
});

test("treats a lot sold after the range as in stock during the requested range", () => {
  const result = findInventoryAvailability(
    [row({ remainingQty: 0, purchaseDate: "2026-09-01" })],
    [{ inventoryId: "INV-1", dateSold: "2026-10-15", qtySold: 1 }],
    "2026-10-01",
    "2026-10-10",
  );

  assert.equal(result.inStock.length, 1);
  assert.equal(result.inStock[0].endDate, "2026-10-15");
  assert.equal(result.soldOut.length, 0);
});

test("does not treat a partial sale as a sold-out end date", () => {
  const result = findInventoryAvailability(
    [row({ remainingQty: 2, qtyPurchased: 3, purchaseDate: "2026-09-01" })],
    [{ inventoryId: "INV-1", dateSold: "2026-10-05", qtySold: 1 }],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.inStock.length, 1);
  assert.equal(result.soldOut.length, 0);
});

test("supports a sold-out record with no purchase date using its sale date as the end basis", () => {
  const result = findInventoryAvailability(
    [row({ remainingQty: 0, purchaseDate: undefined })],
    [{ inventoryId: "INV-1", dateSold: "2026-10-15", qtySold: 1 }],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.soldOut.length, 1);
  assert.equal(result.soldOut[0].dateBasis, "LAST_SALE_DATE");
  assert.equal(result.soldOut[0].startDate, undefined);
  assert.equal(result.soldOut[0].endDate, "2026-10-15");
});

test("keeps an in-stock lot with no purchase date in the undated fallback", () => {
  const result = findInventoryAvailability(
    [row({ purchaseDate: undefined, remainingQty: 2 })],
    [],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.inStock.length, 0);
  assert.equal(result.undated.length, 1);
  assert.equal(result.undated[0].dateBasis, "NO_DATE");
});

test("keeps a sold-out lot with no sale date in the undated fallback", () => {
  const result = findInventoryAvailability(
    [row({ purchaseDate: "2026-09-01", remainingQty: 0 })],
    [],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.soldOut.length, 0);
  assert.equal(result.undated.length, 1);
  assert.equal(result.undated[0].dateBasis, "OPEN_END");
});

test("keeps a completely undated sold-out lot separate", () => {
  const result = findInventoryAvailability(
    [row({ purchaseDate: undefined, remainingQty: 0 })],
    [],
    "2026-10-01",
    "2026-10-31",
  );

  assert.equal(result.soldOut.length, 0);
  assert.equal(result.undated.length, 1);
  assert.equal(result.undated[0].dateBasis, "NO_DATE");
});
