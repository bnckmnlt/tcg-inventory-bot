import type { ParsedV2InventoryRow } from "./v2-workbook.js";

export interface InventoryBriefing {
  lots: number;
  qtyPurchased: number;
  qtySold: number;
  remainingQty: number;
  totalCost: number;
  remainingCost: number;
  revenue: number;
  realizedProfit: number;
  soldThroughPct: number;
  soldOutLots: number;
  lowStockLots: number;
  bestSellers: Array<{ key: string; cardName: string; setSeries: string; cardNumber: string; qtySold: number; revenue: number }>;
  topSellers: Array<{ seller: string; qtyPurchased: number; totalCost: number; lots: number }>;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[,₱]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function cardKey(row: ParsedV2InventoryRow): string {
  return [row.cardName, row.setSeries, row.cardNumber, row.rarity || "", row.condition, row.language, row.variantPrinting || "Normal"]
    .map((value) => String(value || "").trim().toUpperCase()).join("|");
}

export function buildInventoryBriefing(rows: ParsedV2InventoryRow[], lowStockThreshold = 2): InventoryBriefing {
  let qtyPurchased = 0;
  let qtySold = 0;
  let remainingQty = 0;
  let totalCost = 0;
  let remainingCost = 0;
  let revenue = 0;
  let realizedProfit = 0;
  let soldOutLots = 0;
  let lowStockLots = 0;

  const cards = new Map<string, { cardName: string; setSeries: string; cardNumber: string; qtySold: number; revenue: number }>();
  const sellers = new Map<string, { qtyPurchased: number; totalCost: number; lots: number }>();

  for (const row of rows) {
    const purchased = num(row.qtyPurchased);
    const sold = num(row.raw["Qty Sold"]);
    const remaining = Math.max(0, num(row.remainingQty));
    const cost = num(row.raw["Total Cost (₱)"]) || purchased * num(row.unitCost);
    const remainingLotCost = remaining * num(row.unitCost);
    const lotRevenue = num(row.raw["Total Revenue (₱)"]);
    const lotProfit = num(row.raw["Realized Profit / Loss (₱)"]);

    qtyPurchased += purchased;
    qtySold += sold;
    remainingQty += remaining;
    totalCost += cost;
    remainingCost += remainingLotCost;
    revenue += lotRevenue;
    realizedProfit += lotProfit;

    if (remaining <= 0) soldOutLots++;
    else if (remaining <= lowStockThreshold) lowStockLots++;

    if (sold > 0 || lotRevenue !== 0) {
      const key = cardKey(row);
      const current = cards.get(key) ?? { cardName: row.cardName, setSeries: row.setSeries, cardNumber: row.cardNumber, qtySold: 0, revenue: 0 };
      current.qtySold += sold;
      current.revenue += lotRevenue;
      cards.set(key, current);
    }

    const seller = row.seller?.trim() || "Unknown seller";
    const currentSeller = sellers.get(seller) ?? { qtyPurchased: 0, totalCost: 0, lots: 0 };
    currentSeller.qtyPurchased += purchased;
    currentSeller.totalCost += cost;
    currentSeller.lots++;
    sellers.set(seller, currentSeller);
  }

  const bestSellers = [...cards.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.qtySold - a.qtySold || b.revenue - a.revenue || a.cardName.localeCompare(b.cardName))
    .slice(0, 5);

  const topSellers = [...sellers.entries()]
    .map(([seller, value]) => ({ seller, ...value }))
    .sort((a, b) => b.qtyPurchased - a.qtyPurchased || b.totalCost - a.totalCost || a.seller.localeCompare(b.seller))
    .slice(0, 5);

  return {
    lots: rows.length,
    qtyPurchased,
    qtySold,
    remainingQty,
    totalCost,
    remainingCost,
    revenue,
    realizedProfit,
    soldThroughPct: qtyPurchased > 0 ? (qtySold / qtyPurchased) * 100 : 0,
    soldOutLots,
    lowStockLots,
    bestSellers,
    topSellers,
  };
}
