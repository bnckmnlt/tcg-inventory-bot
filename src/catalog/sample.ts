import type { Catalog } from "./types.js";

export const sampleCatalog: Catalog = {
  cards: [
    { catalogCardId: "card-charizard-ex", canonicalName: "Charizard ex", category: "Pokemon" },
    { catalogCardId: "card-pikachu", canonicalName: "Pikachu", category: "Pokemon", dexId: 25 },
    { catalogCardId: "card-psychic-energy", canonicalName: "Basic Psychic Energy", category: "Energy" },
    { catalogCardId: "card-lucian", canonicalName: "Lucian", category: "Trainer" },
    { catalogCardId: "card-drifloon", canonicalName: "Drifloon", category: "Pokemon" },
  ],
  printings: [
    { printingId: "printing-charizard-151-006", catalogCardId: "card-charizard-ex", setId: "sv03.5", setCode: "sv03.5", setName: "151", cardNumber: "006/165", language: "English", rarity: "Double rare", sourceId: "sv03.5-006", active: true },
    { printingId: "printing-charizard-151-199", catalogCardId: "card-charizard-ex", setId: "sv03.5", setCode: "sv03.5", setName: "151", cardNumber: "199/165", language: "English", rarity: "Special Illustration Rare", sourceId: "sv03.5-199", active: true },
    { printingId: "printing-pikachu-promo-088", catalogCardId: "card-pikachu", setId: "svp", setCode: "svp", setName: "Scarlet & Violet Black Star Promos", cardNumber: "088", language: "English", rarity: "Promo", sourceId: "svp-088", active: true },
    { printingId: "printing-psychic-151-207", catalogCardId: "card-psychic-energy", setId: "sv03.5", setCode: "sv03.5", setName: "151", cardNumber: "207/165", language: "English", rarity: "Basic", sourceId: "sv03.5-207", active: true },
    { printingId: "printing-lucian-set-a", catalogCardId: "card-lucian", setId: "set-a", setCode: "seta", setName: "Example Set A", cardNumber: "100/100", language: "English", active: true },
    { printingId: "printing-lucian-set-b", catalogCardId: "card-lucian", setId: "set-b", setCode: "setb", setName: "Example Set B", cardNumber: "101/101", language: "English", active: true },
    { printingId: "printing-drifloon", catalogCardId: "card-drifloon", setId: "set-c", setCode: "setc", setName: "Example Set C", cardNumber: "050/100", language: "English", active: true },
  ],
  variants: [
    { variantId: "variant-charizard-151-006-normal", printingId: "printing-charizard-151-006", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-charizard-151-199-normal", printingId: "printing-charizard-151-199", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-pikachu-promo-088-normal", printingId: "printing-pikachu-promo-088", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-psychic-151-207-normal", printingId: "printing-psychic-151-207", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-lucian-a-normal", printingId: "printing-lucian-set-a", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-lucian-b-normal", printingId: "printing-lucian-set-b", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-drifloon-normal", printingId: "printing-drifloon", variantType: "Normal", variantLabel: "Normal" },
    { variantId: "variant-pikachu-promo-088-pokeball", printingId: "printing-pikachu-promo-088", variantType: "Pattern", variantLabel: "Poké Ball Pattern" },
  ],
  skus: [
    { skuId: "sku-charizard-151-006-nm", variantId: "variant-charizard-151-006-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-charizard-151-199-nm", variantId: "variant-charizard-151-199-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-pikachu-promo-088-nm", variantId: "variant-pikachu-promo-088-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-pikachu-promo-088-pokeball-nm", variantId: "variant-pikachu-promo-088-pokeball", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-psychic-151-207-nm", variantId: "variant-psychic-151-207-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-lucian-a-nm", variantId: "variant-lucian-a-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-lucian-b-nm", variantId: "variant-lucian-b-normal", condition: "Near Mint", language: "English", status: "active" },
    { skuId: "sku-drifloon-nm", variantId: "variant-drifloon-normal", condition: "Near Mint", language: "English", status: "active" },
  ],
};
