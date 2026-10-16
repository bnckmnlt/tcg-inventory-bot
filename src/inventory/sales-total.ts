import type { SaleManagementRecord } from "./sale-management.js";

type SalesTotalRecord = Pick<SaleManagementRecord, "dateSold" | "qtySold" | "revenue" | "cost" | "profit" | "voided">;

export interface CardSalesTotal {
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  condition: string;
  language: string;
  variantPrinting: string;
  transactions: number;
  qtySold: number;
  revenue: number;
  cost: number;
  profit: number;
}

export interface SalesTotal {
  transactions: number;
  cardsSold: number;
  revenue: number;
  cost: number;
  profit: number;
}

function includedSales<T extends SalesTotalRecord>(
  sales: T[],
  from?: string,
  to?: string,
): T[] {
  return sales.filter((sale) =>
    !sale.voided && sale.qtySold > 0 &&
    (!from || !to || Boolean(sale.dateSold && sale.dateSold >= from && sale.dateSold <= to))
  );
}

export function calculateSalesTotal(
  sales: SalesTotalRecord[],
  from?: string,
  to?: string,
): SalesTotal {
  const total: SalesTotal = { transactions: 0, cardsSold: 0, revenue: 0, cost: 0, profit: 0 };

  for (const sale of includedSales(sales, from, to)) {
    total.transactions += 1;
    total.cardsSold += sale.qtySold;
    total.revenue += sale.revenue;
    total.cost += sale.cost;
    total.profit += sale.profit;
  }

  return total;
}

export function calculateCardSalesTotals(
  sales: SaleManagementRecord[],
  from?: string,
  to?: string,
): CardSalesTotal[] {
  const cards = new Map<string, CardSalesTotal>();

  for (const sale of includedSales(sales, from, to)) {
    // Group identical card printings even when sales span different lots and
    // unit costs. Keep condition, language, and variant separate.
    const key = [
      sale.cardName, sale.setSeries, sale.cardNumber, sale.rarity || "",
      sale.condition, sale.language, sale.variantPrinting,
    ].map((value) => value.trim().toLocaleLowerCase()).join("|");
    let card = cards.get(key);
    if (!card) {
      card = {
        cardName: sale.cardName,
        setSeries: sale.setSeries,
        cardNumber: sale.cardNumber,
        rarity: sale.rarity,
        condition: sale.condition,
        language: sale.language,
        variantPrinting: sale.variantPrinting,
        transactions: 0,
        qtySold: 0,
        revenue: 0,
        cost: 0,
        profit: 0,
      };
      cards.set(key, card);
    }
    card.transactions += 1;
    card.qtySold += sale.qtySold;
    card.revenue += sale.revenue;
    card.cost += sale.cost;
    card.profit += sale.profit;
  }

  return [...cards.values()].sort((a, b) =>
    a.cardName.localeCompare(b.cardName) ||
    a.setSeries.localeCompare(b.setSeries) ||
    a.cardNumber.localeCompare(b.cardNumber) ||
    a.condition.localeCompare(b.condition) ||
    a.variantPrinting.localeCompare(b.variantPrinting)
  );
}

function peso(amount: number): string {
  return "₱" + amount.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatSalesTotalExport(
  sales: SaleManagementRecord[],
  from?: string,
  to?: string,
): string {
  const total = calculateSalesTotal(sales, from, to);
  const cards = calculateCardSalesTotals(sales, from, to);
  const blocks = cards.map((card) => [
    `${card.cardName || "Unknown card"}${card.cardNumber ? ` ${card.cardNumber}` : ""}  x${card.qtySold}`,
    [card.setSeries || "Unknown set", card.condition, card.variantPrinting]
      .filter(Boolean).join(" • "),
    `Cost:  ${peso(card.cost)} (avg ${peso(card.cost / card.qtySold)}/card)`,
    `Sales: ${peso(card.revenue)} (avg ${peso(card.revenue / card.qtySold)}/card)`,
    `P/L:   ${peso(card.profit)}`,
  ]);

  // Fill down each column, keeping both headings and financial lines aligned
  // regardless of the length of individual card names or amounts.
  const splitAt = Math.ceil(blocks.length / 2);
  const left = blocks.slice(0, splitAt);
  const right = blocks.slice(splitAt);
  const leftWidth = Math.max(0, ...left.flatMap((block) => block.map((line) => line.length)));
  const cardLines: string[] = [];

  for (let index = 0; index < left.length; index += 1) {
    const leftBlock = left[index];
    const rightBlock = right[index];
    for (let line = 0; line < leftBlock.length; line += 1) {
      cardLines.push(rightBlock
        ? leftBlock[line].padEnd(leftWidth + 3) + rightBlock[line]
        : leftBlock[line]);
    }
    cardLines.push("");
  }

  return [
    "SALES TOTAL",
    `Sale dates: ${from && to ? `${from} to ${to} (inclusive)` : "All recorded sales"}`,
    `Transactions: ${total.transactions}`,
    `Cards sold:   ${total.cardsSold}`,
    `Revenue:      ${peso(total.revenue)}`,
    `Card cost:    ${peso(total.cost)}`,
    `Profit/Loss:  ${peso(total.profit)}`,
    "",
    "CARD BREAKDOWN",
    ...(cardLines.length ? cardLines : ["(none)", ""]),
    "Costs reflect sold cards only. Average unit costs may differ across purchase lots.",
    "Voided sales excluded. Date ranges exclude sales without dates.",
    "",
  ].join("\n");
}
