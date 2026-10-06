export interface SaleManagementRecord {
  saleId: string;
  inventoryId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  condition: string;
  language: string;
  variantPrinting: string;
  dateSold?: string;
  qtySold: number;
  sellPrice: number;
  notes?: string;
  revenue: number;
  cost: number;
  profit: number;
  voided: boolean;
}

export interface SaleEditInput {
  saleId: string;
  sellPrice: number;
  dateSold: string;
  notes?: string;
}

export function validateSaleEdit(input: SaleEditInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateSold)) {
    throw new Error("Date sold must use YYYY-MM-DD.");
  }
  const parsed = new Date(input.dateSold + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.dateSold) {
    throw new Error("Date sold is not a valid calendar date.");
  }
  if (!Number.isFinite(input.sellPrice) || input.sellPrice < 0) {
    throw new Error("Sell price must be a non-negative PHP amount.");
  }
  if (!/^SALE-\d+$/i.test(input.saleId)) {
    throw new Error("Sale ID must look like SALE-000001.");
  }
}
