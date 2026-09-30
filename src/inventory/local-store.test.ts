import assert from "node:assert/strict";
import test from "node:test";
import type { InvoiceData } from "../extract.js";
import { sampleCatalog } from "../catalog/sample.js";
import { planInvoiceIngestion } from "./ingest.js";
import { applyInsertionPlan, InMemoryInventoryStore } from "./local-store.js";

function invoice(lineItems: InvoiceData["lineItems"]): InvoiceData {
  return {
    seller: "Test Seller",
    purchaseDate: "2026-09-30",
    orderId: "LOCAL-001",
    subtotal: 20,
    shipping: 0,
    tax: 0,
    total: 20,
    currency: "PHP",
    lineItems,
    uncertainFields: [],
  };
}

test("applies only verified INSERT rows to the local store", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([
    {
      productName: "Charizard ex",
      setName: "151",
      cardNumber: "6/165",
      condition: "Near Mint",
      rarity: "Double Rare",
      language: "English",
      variant: "Normal",
      quantity: 1,
      unitPrice: 10,
      totalPrice: 10,
    },
    {
      productName: "Articuno",
      setName: "Trading Card Game Classic",
      cardNumber: "9",
      condition: "Near Mint",
      rarity: "Holofoil",
      language: "English",
      variant: "Holofoil",
      quantity: 1,
      unitPrice: 10,
      totalPrice: 10,
    },
  ]), "local-001");

  const store = new InMemoryInventoryStore();
  const applied = applyInsertionPlan(store, plan.rows);

  assert.deepEqual(applied, { inserted: 2, skipped: 0, pendingReview: 0 });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].cardName, "Charizard ex");
});

test("reapplying the same plan is idempotent", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Charizard ex",
    setName: "151",
    cardNumber: "6/165",
    condition: "Near Mint",
    rarity: "Double Rare",
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "local-002");

  const store = new InMemoryInventoryStore();
  assert.deepEqual(applyInsertionPlan(store, plan.rows), {
    inserted: 1,
    skipped: 0,
    pendingReview: 0,
  });
  assert.deepEqual(applyInsertionPlan(store, plan.rows), {
    inserted: 0,
    skipped: 1,
    pendingReview: 0,
  });
  assert.equal(store.list().length, 1);
});

test("records purchases even when SKU resolution is incomplete", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Pikachu",
    setName: "Trick or Trade BOOster Bundle 2023",
    cardNumber: "62",
    condition: "Lightly Played",
    rarity: "Holofoil",
    language: "English",
    variant: "Holofoil",
    quantity: 1,
    unitPrice: 5,
    totalPrice: 5,
  }]), "local-003");

  const store = new InMemoryInventoryStore();
  const applied = applyInsertionPlan(store, plan.rows);

  assert.equal(applied.inserted, 1);
  assert.equal(applied.pendingReview, 0);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].skuId, undefined);
});
