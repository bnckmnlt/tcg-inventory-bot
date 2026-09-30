import type { V2InventoryRow } from "./types.js";

/**
 * Representative fixture derived from the V2 workbook's column structure and
 * known identity edge cases. This is not a migrated copy of the workbook.
 */
export const v2InventorySample: V2InventoryRow[] = [
  {
    inventoryId: "INV-000001",
    cardName: "Charizard ex",
    setSeries: "151",
    cardNumber: "006/165",
    rarity: "Double rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 2,
  },
  {
    inventoryId: "INV-000002",
    cardName: "Charizard ex",
    setSeries: "151",
    cardNumber: "199/165",
    rarity: "Special Illustration Rare",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 1,
  },
  {
    inventoryId: "INV-000003",
    cardName: "Pikachu",
    setSeries: "Scarlet & Violet Black Star Promos",
    cardNumber: "088",
    rarity: "Promo",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Poké Ball Pattern",
    remainingQty: 3,
  },
  {
    inventoryId: "INV-000004",
    cardName: "Lucian",
    setSeries: "Example Set A",
    cardNumber: "100/100",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 1,
  },
  {
    inventoryId: "INV-000005",
    cardName: "Basic Psychic Energy",
    setSeries: "151",
    cardNumber: "1",
    rarity: "Basic",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 4,
  },
  {
    inventoryId: "INV-000006",
    cardName: "Drifblim",
    setSeries: "Example Set C",
    cardNumber: "050/100",
    condition: "Near Mint",
    language: "English",
    variantPrinting: "Normal",
    remainingQty: 1,
  },
];
