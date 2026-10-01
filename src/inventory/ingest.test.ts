import assert from "node:assert/strict";
import test from "node:test";
import type { InvoiceData } from "../extract.js";
import { sampleCatalog } from "../catalog/sample.js";
import { planInvoiceIngestion, purchaseIdentityKeys } from "./ingest.js";

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

test("canonicalizes foil variants to the inventory import labels", () => {
  const holo = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Charizard ex",
    setName: "151",
    cardNumber: "6/165",
    condition: "Near Mint",
    rarity: "Double Rare",
    language: "English",
    variant: "Foil",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-foil");

  assert.equal(holo.rows[0].input.variantPrinting, "Holofoil");

  const reverse = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Pikachu",
    setName: "Scarlet & Violet Black Star Promos",
    cardNumber: "088",
    condition: "Near Mint",
    rarity: "Promo",
    language: "English",
    variant: "Reverse Holofoil",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-reverse-foil");

  assert.equal(reverse.rows[0].input.variantPrinting, "Reverse Holofoil");
});

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

test("fills a missing card number from an exact catalog printing", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Pikachu",
    setName: "Scarlet & Violet Black Star Promos",
    cardNumber: null,
    condition: "Near Mint",
    rarity: "Promo",
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-infer-number", new Set(), { allowMissingCardNumber: true });

  assert.equal(plan.insertable, 1);
  assert.equal(plan.rows[0].state, "EXACT");
  assert.equal(plan.rows[0].input.cardNumber, "088");
  assert.match(plan.rows[0].input.resolutionReasons?.at(-1) ?? "", /inferred from the exact catalog printing: 088/);
});

test("uses a reviewable card-number sentinel when no number can be verified", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Unknown Card",
    setName: "Unknown Set",
    cardNumber: null,
    condition: "Near Mint",
    rarity: null,
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 10,
    totalPrice: 10,
  }]), "msg-card-number-fallback", new Set(), { allowMissingCardNumber: true });

  assert.equal(plan.insertable, 1);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].input.cardNumber, "1");
  assert.equal(plan.rows[0].input.reviewRequired, true);
  assert.deepEqual(plan.rows[0].input.reviewFlags, ["CARD_NUMBER_UNCERTAIN"]);
  assert.match(plan.rows[0].input.reviewNotes?.[0] ?? "", /temporary value "1" was used/);
});

test("records a stable purchase even when no SKU exists", () => {
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

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].state, "INCOMPLETE");
  assert.equal(plan.rows[0].skuId, undefined);
  assert.equal(plan.rows[0].input.skuId, undefined);
});

test("records ambiguous or conflicting purchases without inventing a SKU", () => {
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

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].state, "CONFLICT");
  assert.equal(plan.rows[0].skuId, undefined);
});

test("flags uncertain card extraction without blocking the purchase", () => {
  const plan = planInvoiceIngestion(sampleCatalog, {
    ...invoice([{
      productName: "Pawmi",
      setName: "Example Set",
      cardNumber: null,
      condition: "Near Mint",
      rarity: "Common",
      language: "English",
      variant: "Normal",
      quantity: 1,
      unitPrice: 1.5,
      totalPrice: 1.5,
    }]),
    uncertainFields: ["productName row 1: text is difficult to read"],
  }, "msg-uncertain", new Set(), { allowMissingCardNumber: true });

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].input.reviewRequired, true);
  assert.deepEqual(plan.rows[0].input.reviewFlags, ["CARD_NAME_UNCERTAIN", "CARD_NUMBER_UNCERTAIN"]);
  assert.match(plan.rows[0].input.reviewNotes?.[0] ?? "", /difficult to read/);
});

test("does not treat missing SKU as an extraction review issue", () => {
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
  }]), "msg-no-sku-review");

  assert.equal(plan.rows[0].input.reviewRequired, false);
  assert.deepEqual(plan.rows[0].input.reviewFlags, undefined);
});

test("records Dunsparce as a purchase even when catalog identity is unresolved", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Dunsparce",
    setName: "SWSH Crown Zenith: Galarian Gallery",
    cardNumber: null,
    condition: "Near Mint",
    rarity: "Holo Rare",
    language: "English",
    variant: "Holo",
    quantity: 1,
    unitPrice: 2.5,
    totalPrice: 2.5,
  }]), "msg-dunsparce", new Set(), { allowMissingCardNumber: true });

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.rows[0].action, "INSERT");
  assert.equal(plan.rows[0].input.cardName, "Dunsparce");
  assert.equal(plan.rows[0].input.qtyPurchased, 1);
  assert.equal(plan.rows[0].input.unitCost, 2.5);
  assert.equal(plan.rows[0].input.skuId, undefined);
});

test("offsets source lines for continuation pages", () => {
  const plan = planInvoiceIngestion(sampleCatalog, invoice([{
    productName: "Pikachu",
    setName: "Base Set",
    cardNumber: "025",
    condition: "Near Mint",
    rarity: "Common",
    language: "English",
    variant: "Normal",
    quantity: 1,
    unitPrice: 1,
    totalPrice: 1,
  }]), "PAGE-2", new Set(), {
    allowMissingCardNumber: true,
    sourceLineOffset: 25,
  });

  assert.equal(plan.rows[0].sourceLine, 26);
  assert.equal(plan.rows[0].input.sourceLine, 26);
  assert.equal(plan.rows[0].ingestionKey, "PAGE-2:line:26");
});

test("skips an already-recorded invoice line by order and source line", () => {
  const existing = new Set(["order:test-001:line:1"]);
  const plan = planInvoiceIngestion(sampleCatalog, invoice([
    {
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
    },
    {
      productName: "Charizard ex",
      setName: "151",
      cardNumber: "006",
      condition: "Near Mint",
      rarity: null,
      language: "English",
      variant: "Normal",
      quantity: 2,
      unitPrice: 10,
      totalPrice: 20,
    },
  ]), "new-message", existing);

  assert.equal(plan.insertable, 1);
  assert.equal(plan.pendingReview, 0);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.rows[0].action, "SKIP");
  assert.equal(plan.rows[0].input.reviewRequired, false);
  assert.equal(plan.rows[0].input.reviewFlags, undefined);
  assert.equal(plan.rows[1].action, "INSERT");
});

test("keeps extraction review metadata on the inventory input", () => {
  const plan = planInvoiceIngestion(sampleCatalog, {
    ...invoice([{
      productName: "Pawmi",
      setName: "Example Set",
      cardNumber: "001",
      condition: "Near Mint",
      rarity: "Common",
      language: "English",
      variant: "Normal",
      quantity: 1,
      unitPrice: 1.5,
      totalPrice: 1.5,
    }]),
    uncertainFields: [
      "productName row 1: text is difficult to read",
      "quantity row 1: unclear",
    ],
  }, "msg-review");

  const input = plan.rows[0].input;
  assert.equal(input.reviewRequired, true);
  assert.deepEqual(input.reviewFlags, ["CARD_NAME_UNCERTAIN", "QUANTITY_UNCERTAIN"]);
  assert.deepEqual(input.reviewNotes, [
    "productName row 1: text is difficult to read",
    "quantity row 1: unclear",
  ]);
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

test("makes reuploads idempotent when an invoice has no order ID", () => {
  const original = planInvoiceIngestion(sampleCatalog, {
    ...invoice([{
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
    }]),
    orderId: null,
  }, "original-message");

  const existing = new Set(
    purchaseIdentityKeys(original.rows[0].input),
  );

  const retry = planInvoiceIngestion(sampleCatalog, {
    ...invoice([{
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
    }]),
    orderId: null,
  }, "reupload-message", existing, { allowMissingCardNumber: true });

  assert.equal(retry.insertable, 0);
  assert.equal(retry.pendingReview, 0);
  assert.equal(retry.skipped, 1);
  assert.equal(retry.rows[0].action, "SKIP");
  assert.equal(retry.rows[0].input.reviewRequired, false);
});
