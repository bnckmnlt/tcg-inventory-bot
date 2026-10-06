import { EmbedBuilder } from "discord.js";
import type { ParsedV2InventoryRow } from "../inventory/v2-workbook.js";
import type { BriefingSaleRecord } from "../inventory/briefing.js";
import { getInventoryAlerts } from "../inventory/alerts.js";

const PHOSPHOR_ICON_BASE = "https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2.1.1/assets/regular";

export const DISCORD_ICONS = {
  package: `${PHOSPHOR_ICON_BASE}/package.svg`,
  checkCircle: `${PHOSPHOR_ICON_BASE}/check-circle.svg`,
  warningCircle: `${PHOSPHOR_ICON_BASE}/warning-circle.svg`,
  xCircle: `${PHOSPHOR_ICON_BASE}/x-circle.svg`,
  chartLineUp: `${PHOSPHOR_ICON_BASE}/chart-line-up.svg`,
  coins: `${PHOSPHOR_ICON_BASE}/coins.svg`,
  truck: `${PHOSPHOR_ICON_BASE}/truck.svg`,
  magnifyingGlass: `${PHOSPHOR_ICON_BASE}/magnifying-glass.svg`,
  receipt: `${PHOSPHOR_ICON_BASE}/receipt.svg`,
  warning: `${PHOSPHOR_ICON_BASE}/warning.svg`,
} as const;

export const DISCORD_COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  financial: 0xf1c40f,
  sales: 0x9b59b6,
} as const;

export function withIcon(embed: EmbedBuilder, iconUrl: string): EmbedBuilder {
  return embed.setThumbnail(iconUrl).setTimestamp();
}

export function inventorySearchEmbed(row: ParsedV2InventoryRow): EmbedBuilder {
  const status = row.remainingQty <= 0 ? "Sold Out" : row.remainingQty <= 2 ? "Low Stock" : "In Stock";
  const icon = row.remainingQty <= 0 ? DISCORD_ICONS.xCircle : row.remainingQty <= 2 ? DISCORD_ICONS.warningCircle : DISCORD_ICONS.checkCircle;
  return withIcon(new EmbedBuilder()
    .setColor(row.remainingQty <= 0 ? DISCORD_COLORS.danger : row.remainingQty <= 2 ? DISCORD_COLORS.warning : DISCORD_COLORS.success)
    .setTitle(row.cardName)
    .setDescription([row.setSeries, row.cardNumber ? "#" + row.cardNumber : "", row.rarity ?? "", row.variantPrinting || "Normal"].filter(Boolean).join(" • "))
    .addFields(
      { name: "Inventory ID", value: row.inventoryId, inline: true },
      { name: "Remaining", value: String(row.remainingQty), inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Condition", value: row.condition || "—", inline: true },
      { name: "Language", value: row.language || "—", inline: true },
      { name: "Unit Cost", value: row.unitCost == null ? "—" : "₱" + row.unitCost.toFixed(2), inline: true },
      { name: "Purchased", value: row.qtyPurchased == null ? "—" : String(row.qtyPurchased), inline: true },
      { name: "Seller", value: row.seller || "—", inline: true },
      { name: "Order ID", value: row.orderId || "—", inline: true },
    ), icon);
}

export function inventorySearchResultsEmbed(query: string, count: number, limit: number): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.primary)
    .setTitle(query ? "Inventory Search Results" : "Inventory")
    .setDescription([
      query ? `Search results for **${query}**.` : "Available inventory records.",
      count === limit ? `Showing the first ${limit} matches.` : `Found **${count}** matching record(s).`,
      "Select a record below to view its details.",
    ].join("\n")), DISCORD_ICONS.magnifyingGlass);
}

export function inventorySearchEmptyEmbed(query: string): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.warning)
    .setTitle("Inventory Search")
    .setDescription(query ? `No inventory records matched **${query}**.` : "There are no inventory records to display."), DISCORD_ICONS.magnifyingGlass);
}

export function saleSearchResultsEmbed(query: string, count: number, limit: number): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.sales)
    .setTitle(query ? "Sale Search Results" : "Available Inventory")
    .setDescription([
      query ? `Search results for **${query}**.` : "Available inventory records.",
      count === limit ? `Showing the first ${limit} matches.` : `Found **${count}** matching record(s).`,
      "Select the exact inventory record below to continue the sale.",
    ].join("\n")), DISCORD_ICONS.receipt);
}

export function saleSearchEmptyEmbed(query: string): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.warning)
    .setTitle("Sales Search")
    .setDescription(query
      ? `No available inventory records matched **${query}**. Search by card name, set, card number, rarity, condition, variant, or Inventory ID.`
      : "There is no available inventory to sell."), DISCORD_ICONS.receipt);
}

export function saleReviewEmbed(args: {
  cardName: string;
  cardNumber: string;
  setSeries: string;
  rarity: string;
  variant: string;
  condition: string;
  language: string;
  inventoryId: string;
  dateSold: string;
  qtySold: number;
  sellPrice: number;
  totalRevenue: number;
  estimatedCost: number;
  allocationSummary: string;
  notes?: string;
}): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.sales)
    .setTitle("Sale Review")
    .setDescription([
      `**${args.cardName} — ${args.cardNumber}**`,
      `${args.setSeries} • ${args.rarity || "Rarity not set"} • ${args.variant || "Normal"}`,
      `${args.condition} • ${args.language}`,
    ].join("\n"))
    .addFields(
      { name: "Inventory", value: args.inventoryId, inline: true },
      { name: "Date Sold", value: args.dateSold, inline: true },
      { name: "Quantity", value: String(args.qtySold), inline: true },
      { name: "Sell Price", value: `₱${args.sellPrice.toFixed(2)} each`, inline: true },
      { name: "Revenue", value: `₱${args.totalRevenue.toFixed(2)}`, inline: true },
      { name: "Inventory Cost Preview", value: `₱${args.estimatedCost.toFixed(2)}`, inline: true },
      { name: "Selected Lot Allocation", value: args.allocationSummary || "No allocation details.", inline: false },
      ...(args.notes ? [{ name: "Notes", value: args.notes.slice(0, 1024), inline: false }] : []),
    )
    .setFooter({ text: "Confirming writes the Sale Log row and Cost Allocation for this selected inventory lot only." }), DISCORD_ICONS.receipt);
}

export function selectedInventoryEmbed(row: ParsedV2InventoryRow): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.sales)
    .setTitle("Selected Inventory")
    .setDescription([
      `**${row.cardName} — ${row.cardNumber}**`,
      `${row.setSeries} • ${row.rarity || "Rarity not set"} • ${row.variantPrinting || "Normal"}`,
      `${row.condition} • ${row.language}`,
    ].join("\n"))
    .addFields(
      { name: "Inventory ID", value: row.inventoryId, inline: true },
      { name: "Available", value: String(row.remainingQty), inline: true },
      { name: "Unit Cost", value: `₱${row.unitCost.toFixed(2)}`, inline: true },
    )
    .setFooter({ text: "Quantity and sell price will be entered next." }), DISCORD_ICONS.receipt);
}

export function saleManagementEmbed(record: {
  saleId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  variantPrinting: string;
  condition: string;
  language: string;
  inventoryId: string;
  dateSold?: string;
  qtySold: number;
  sellPrice: number;
  revenue: number;
  cost: number;
  profit: number;
  notes?: string;
  voided: boolean;
}): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(record.voided ? DISCORD_COLORS.danger : DISCORD_COLORS.sales)
    .setTitle(record.voided ? "Sale — Voided" : "Sale Management")
    .setDescription([
      `**${record.cardName} — ${record.cardNumber}**`,
      `${record.setSeries} • ${record.rarity || "Rarity not set"} • ${record.variantPrinting || "Normal"}`,
      `${record.condition} • ${record.language}`,
    ].join("\n"))
    .addFields(
      { name: "Sale ID", value: record.saleId, inline: true },
      { name: "Inventory", value: record.inventoryId, inline: true },
      { name: "Date Sold", value: record.dateSold || "—", inline: true },
      { name: "Quantity", value: String(record.qtySold), inline: true },
      { name: "Sell Price", value: `₱${record.sellPrice.toFixed(2)} each`, inline: true },
      { name: "Revenue", value: `₱${record.revenue.toFixed(2)}`, inline: true },
      { name: "Cost", value: `₱${record.cost.toFixed(2)}`, inline: true },
      { name: "Profit / Loss", value: `₱${record.profit.toFixed(2)}`, inline: true },
      ...(record.notes ? [{ name: "Notes", value: record.notes.slice(0, 1024), inline: false }] : []),
    )
    .setFooter({ text: record.voided ? "This sale is voided. Its inventory allocation has been restored." : "Edit changes price/date/notes. Rollback voids the sale and restores its inventory allocation." }),
    DISCORD_ICONS.receipt);
}

export function salePreparationErrorEmbed(message: string): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.danger)
    .setTitle("Sale Could Not Be Prepared")
    .setDescription(message), DISCORD_ICONS.warning);
}

export function inventoryAlertsEmbeds(
  alerts: ReturnType<typeof getInventoryAlerts>,
  summary: { soldOut: number; lowStock: number; total: number },
  threshold: number,
  truncate: (value: string, maxLength: number) => string,
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  for (let start = 0; start < alerts.length; start += 25) {
    const embed = new EmbedBuilder()
      .setColor(summary.soldOut > 0 ? DISCORD_COLORS.danger : DISCORD_COLORS.warning)
      .setTitle(start === 0 ? "Inventory Alerts" : "Inventory Alerts — continued")
      .setDescription(
        start === 0
          ? `Sold out: **${summary.soldOut}** • Low stock: **${summary.lowStock}** • Total: **${summary.total}**\nLow-stock threshold: **${threshold}** remaining unit(s).`
          : "Additional inventory alerts.",
      );
    alerts.slice(start, start + 25).forEach((alert) => {
      const row = alert.row;
      const marker = alert.type === "SOLD_OUT" ? "SOLD OUT" : "LOW STOCK";
      embed.addFields({
        name: marker + " — " + truncate(row.cardName, 80),
        value: [
          "Inventory: " + row.inventoryId,
          "Set: " + (row.setSeries || "Unknown") + (row.cardNumber ? " • #" + row.cardNumber : ""),
          "Remaining: **" + row.remainingQty + "**" + (row.rarity ? " • " + row.rarity : "") + (row.variantPrinting ? " • " + row.variantPrinting : ""),
        ].join("\n"),
        inline: false,
      });
    });
    const icon = summary.soldOut > 0 ? DISCORD_ICONS.xCircle : DISCORD_ICONS.warningCircle;
    embeds.push(withIcon(embed, icon));
  }
  return embeds;
}

export function inventoryAlertsEmptyEmbed(threshold: number): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.success)
    .setTitle("Inventory Alerts")
    .setDescription([
      "No sold-out or low-stock records need attention.",
      `Low-stock threshold: **${threshold}** remaining unit(s).`,
    ].join("\n")), DISCORD_ICONS.checkCircle);
}

export interface InventoryAvailabilityEmbedRecord {
  inventoryId: string;
  cardName: string;
  setSeries: string;
  cardNumber: string;
  rarity?: string;
  variantPrinting: string;
  condition: string;
  language: string;
  remainingQty: number;
  startDate?: string;
  endDate?: string;
  dateBasis: string;
}

function embedCharacterLength(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  return [
    data.title,
    data.description,
    data.footer?.text,
    data.author?.name,
    ...(data.fields ?? []).flatMap((field) => [field.name, field.value]),
  ].filter((value): value is string => typeof value === "string").reduce((total, value) => total + value.length, 0);
}

function availabilityRecordValue(record: InventoryAvailabilityEmbedRecord, showRemainingQty = true): string {
  return [
    `${record.setSeries || "Unknown"}${record.cardNumber ? ` • #${record.cardNumber}` : ""}`,
    [record.rarity, record.variantPrinting || "Normal", record.condition, record.language].filter(Boolean).join(" • "),
    showRemainingQty ? `Remaining: **${record.remainingQty}**` : undefined,
  ].filter(Boolean).join("\n");
}

export function inventoryAvailabilitySummaryEmbed(from: string, to: string, counts: { inStock: number; soldOut: number; undated: number }): EmbedBuilder {
  return withIcon(new EmbedBuilder()
    .setColor(DISCORD_COLORS.primary)
    .setTitle("Inventory Availability")
    .setDescription([
      `Requested range: **${from} → ${to}**`,
      "",
      `**In Stock:** ${counts.inStock}`,
      `**Sold Out:** ${counts.soldOut}`,
      `**Undated / Open Date:** ${counts.undated}`,
      "",
      "This is a current inventory-status view using purchase dates and recorded sale dates as temporal boundaries.",
    ].join("\n")), DISCORD_ICONS.magnifyingGlass);
}

export function inventoryAvailabilityEmbeds(
  title: "In Stock" | "Sold Out" | "Undated / Open Date",
  records: InventoryAvailabilityEmbedRecord[],
): EmbedBuilder[] {
  if (records.length === 0) return [];

  const icon = title === "In Stock"
    ? DISCORD_ICONS.checkCircle
    : title === "Sold Out"
      ? DISCORD_ICONS.xCircle
      : DISCORD_ICONS.warningCircle;
  const color = title === "In Stock"
    ? DISCORD_COLORS.success
    : title === "Sold Out"
      ? DISCORD_COLORS.danger
      : DISCORD_COLORS.warning;

  const embeds: EmbedBuilder[] = [];
  const description = title === "Undated / Open Date"
    ? "These records cannot be placed precisely in the requested range because a purchase date is missing. They are kept separate rather than being assigned an invented date."
    : title === "Sold Out"
      ? "These lots were sold out within or overlapping the requested range based on their purchase date and latest recorded sale date."
      : "These lots were purchased on or before the requested range and still have stock remaining.";

  // Discord's embed limit is 6,000 characters per embed. Build each embed
  // incrementally so long card/set names cannot push an otherwise valid page
  // over the limit. Keep a safety margin for the embed metadata.
  let embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);

  let currentLength = embedCharacterLength(embed);
  let page = 1;

  for (const record of records) {
    const field = {
      name: record.cardName.slice(0, 256),
      value: availabilityRecordValue(record, title !== "Sold Out").slice(0, 1024),
      inline: true,
    };
    const fieldLength = field.name.length + field.value.length;

    if (
      embed.data.fields?.length &&
      (embed.data.fields.length >= 25 || currentLength + fieldLength > 5000)
    ) {
      embeds.push(withIcon(embed, icon));
      page += 1;
      embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${title} — continued${page > 2 ? ` ${page}` : ""}`)
        .setDescription(description);
      currentLength = embedCharacterLength(embed);
    }

    embed.addFields(field);
    currentLength += fieldLength;
  }

  if (embed.data.fields?.length) {
    embeds.push(withIcon(embed, icon));
  }

  return embeds;
}
