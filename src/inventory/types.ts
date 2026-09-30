import type { CardInput, MatchState, Sku } from "../catalog/types.js";

export type ReviewFlag =
  | "LOW_IMAGE_CONFIDENCE"
  | "CARD_NAME_UNCERTAIN"
  | "SET_UNCERTAIN"
  | "CARD_NUMBER_UNCERTAIN"
  | "CONDITION_UNCERTAIN"
  | "VARIANT_UNCERTAIN"
  | "QUANTITY_UNCERTAIN"
  | "PRICE_UNCERTAIN";

export interface V2InventoryRow {
  inventoryId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  condition: string;
  language: string;
  variantPrinting: string;
  remainingQty: number;
  qtyPurchased?: number;
  unitCost?: number;
  totalCost?: number;
  purchaseDate?: string;
  seller?: string;
  orderId?: string;
  skuId?: string;
  resolutionState?: MatchState;
  resolutionReasons?: string[];
  reviewRequired?: boolean;
  reviewFlags?: ReviewFlag[];
  reviewNotes?: string[];
}

export interface ResolvedInventoryLot {
  inventoryId: string;
  input: CardInput;
  remainingQty: number;
  state: MatchState;
  sku?: Sku;
  reasons: string[];
}

export interface InventoryResolution {
  state: MatchState;
  input: CardInput;
  lots: ResolvedInventoryLot[];
  reasons: string[];
}
