import type { CardInput, MatchState, Sku } from "../catalog/types.js";

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
