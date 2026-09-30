import assert from "node:assert/strict";
import test from "node:test";
import { sampleCatalog } from "./sample.js";
import type { Catalog } from "./types.js";
import { resolveCardInput } from "./resolver.js";
import { normalizeText } from "./normalize.js";

test("normalizes common HTML entities in invoice names", () => {
  assert.equal(normalizeText("Wally&apos;s Compass &amp; Ethan&#39;s Adventure"), "wally's compass & ethan's adventure");
});

test("resolves Charizard ex 151 #006 deterministically", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "6/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-charizard-151-006-nm");
});

test("distinguishes two Charizard ex printings by number", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "199/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-charizard-151-199-nm");
});

test("does not use name alone to resolve a duplicated name", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Lucian",
    condition: "Near Mint",
    language: "English",
  });
  assert.equal(result.state, "AMBIGUOUS");
});

test("handles a variant without changing the underlying printing", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Pikachu",
    setName: "Scarlet & Violet Black Star Promos",
    cardNumber: "088",
    language: "English",
    variant: "Poké Ball Pattern",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.variant?.variantLabel, "Poké Ball Pattern");
});

test("keeps Basic Psychic Energy identified by printing number", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Basic Psychic Energy",
    setName: "151",
    cardNumber: "207/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-psychic-151-207-nm");
});

test("strips known V2 printing suffixes from the card name", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Drifloon (Cosmos Holo)",
    setName: "Example Set C",
    cardNumber: "050/100",
    language: "English",
    variant: "Normal",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.variant?.variantLabel, "Normal");
});

const incompleteIdentityCases = [
  ["Articuno", "Trading Card Game Classic", "9", "tcg-classic-clb-009"],
  ["Basic Fighting Energy", "TCG Classic", "34", "tcg-classic-clv-034"],
  ["Basic Grass Energy", "TCG Classic", "33", "tcg-classic-clv-033"],
  ["Basic Psychic Energy", "TCG Classic", "34", "tcg-classic-clb-034"],
  ["Basic Water Energy", "TCG Classic", "33", "tcg-classic-clb-033"],
  ["Pokemon Fan Club (CLB)", "TCG Classic", "22", "tcg-classic-clb-024"],
  ["Pokemon Fan Club (CLC)", "TCG Classic", "22", "tcg-classic-clc-022"],
  ["Pokemon Fan Club (CLV)", "TCG Classic", "22", "tcg-classic-clv-022"],
  ["Binding Mochi (Pokeball Patt.)", "SV: Prismatic Evolutions", "95", "sv08.5-095"],
  ["Pokegear 3.0", "SWSH01: Sword and Shield Base Set", "174", "swsh1-174"],
  ["Pikachu", "Trick or Trade BOOster Bundle 2023", "62", "tt2023-062"],
] as const;

for (const [name, setName, cardNumber, sourceId] of incompleteIdentityCases) {
  test(`keeps stable identity incomplete without inventing a SKU: ${name} ${cardNumber}`, () => {
    const result = resolveCardInput(sampleCatalog, {
      name,
      setName,
      cardNumber,
      language: "English",
      condition: "Near Mint",
      variant: name.includes("Pokeball") ? "Poké Ball Pattern" : undefined,
    });
    assert.equal(result.state, "INCOMPLETE");
    assert.equal(result.printing?.sourceId, sourceId);
    assert.equal(result.sku, undefined);
    assert.match(result.reasons.join(" "), /no local SKU is available/i);
  });
}

test("accepts the verified Wally's Compass invoice alias for Wally's Compassion #176", () => {
  const catalog: Catalog = {
    sets: [{ setId: "set-me01", sourceSetId: "me01", setCode: "me01", setName: "Mega Evolution", status: "active" }],
    cards: [{ catalogCardId: "card-wally", canonicalName: "Wally's Compassion", category: "Trainer" }],
    printings: [{ printingId: "printing-wally-176", catalogCardId: "card-wally", setId: "set-me01", setCode: "me01", setName: "Mega Evolution", cardNumber: "176/132", language: "English", rarity: "Ultra Rare", sourceId: "me01-176", active: true }],
    variants: [{ variantId: "variant-wally-176-normal", printingId: "printing-wally-176", variantType: "Holo", variantLabel: "Holo" }],
    skus: [{ skuId: "sku-wally-176-nm", variantId: "variant-wally-176-normal", condition: "Near Mint", language: "English", status: "active" }],
    externalIdMappings: [],
  };
  const result = resolveCardInput(catalog, {
    name: "Wally's Compass - 176/132",
    setName: "ME01: Mega Evolution",
    cardNumber: "176/132",
    language: "English",
    variant: "Holo",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-wally-176-nm");
});

test("flags a name conflict instead of silently accepting it", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Drifblim",
    setName: "Example Set C",
    cardNumber: "050/100",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "CONFLICT");
  assert.match(result.reasons.join(" "), /conflicts with the catalog printing/);
});
