import assert from "node:assert/strict";
import test from "node:test";
import { importTCGdex } from "./tcgdex.js";

test("imports a real TCGdex set and preserves source IDs", async () => {
  const catalog = await importTCGdex({
    setIds: ["sv03.5"],
    language: "en",
    conditions: ["Near Mint"],
  });

  const charizard = catalog.printings.find((printing) => printing.sourceId === "sv03.5-006");
  assert.ok(charizard);
  assert.equal(charizard.setName, "151");
  assert.equal(charizard.cardNumber, "006");
  assert.equal(charizard.language, "English");
  assert.ok(charizard.printingId.startsWith("printing-"));

  const charizardVariants = catalog.variants.filter((variant) => variant.printingId === charizard.printingId);
  assert.ok(charizardVariants.length >= 1);
  assert.ok(catalog.skus.some((sku) => sku.variantId === charizardVariants[0].variantId && sku.condition === "Near Mint"));
});
