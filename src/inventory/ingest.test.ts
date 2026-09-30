import assert from "node:assert/strict";
import test from "node:test";
import type { InvoiceData } from "../extract.js";
import { sampleCatalog } from "../catalog/sample.js";
import { planInvoiceIngestion } from "./ingest.js";

function invoice(lineItems: InvoiceData["lineItems"]): InvoiceData {
  return {
    seller: "Test Seller",
    purchaseDate: "2026-09-30",
    orderId: "TEST-001",
    subtotal: 10,
    shipping: 0,
    tax: 0,
    total: 10,
    currency: "PHP",
    lineItems,
    uncertainFields: [],
  };
}

test("plans an exact parsed card for insertion", () => {
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
  }]), "msg-001");

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].state, "EXACT");
  assert.equal(plan.rows[0].skuId, "sku-charizard-151-006-nm");
});

test("holds incomplete parsed data for review", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Charizard ex",
    setName: "151",
    cardNumber: null,
    condition: "Near Mint",
    rarity: null,
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-002");

  assert.equal(plan.insertable, 0);
  assert.equal(plan.pendingReview, 1);
  assert.equal(plan.rows[0].action, "PENDING_REVIEW");
  assert.equal(plan.rows[0].state, "INCOMPLETE");
});

test("holds a stable identity with no SKU instead of inventing one", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
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
  }]), "msg-003");

  assert.equal(plan.insertable, 0);
  assert.equal(plan.pendingReview, 1);
  assert.equal(plan.rows[0].state, "INCOMPLETE");
  assert.equal(plan.rows[0].skuId, undefined);
});

test("holds ambiguous or conflicting resolver results for review", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Drifblim",
    setName: "Example Set C",
    cardNumber: "050/100",
    condition: "Near Mint",
    rarity: null,
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-004");

  assert.equal(plan.insertable, 0);
  assert.equal(plan.pendingReview, 1);
  assert.equal(plan.rows[0].action, "PENDING_REVIEW");
  assert.equal(plan.rows[0].state, "CONFLICT");
});

test("makes retries idempotent when the generated inventory ID already exists", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Charizard ex",
    setName: "151",
    cardNumber: "006",
    condition: "Near Mint",
    rarity: null,
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-005", new Set(["IMG-msg-005-001"]));

  assert.equal(plan.insertable, 0);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.rows[0].action, "SKIP");
});
