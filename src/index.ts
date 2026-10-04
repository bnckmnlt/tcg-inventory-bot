import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  TextChannel,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readV2InventoryWorkbook } from "./inventory/read-xlsx.js";
import { createInventoryBackup } from "./inventory/backup.js";
import { downloadInvoice } from "./invoice.js";
import { extractInvoice } from "./extract.js";
import { enrichCardInput, mergeCatalog } from "./catalog/enrichment.js";
import { TCGdexRuntime } from "./catalog/runtime.js";
import type { Catalog } from "./catalog/types.js";
import { planInvoiceIngestion, purchaseIdentityKeys, type IngestionPlan } from "./inventory/ingest.js";
import { createJsonInventoryStore } from "./inventory/json-store.js";
import { invoicePlanToWorkbookRows, persistInvoicePlanToWorkbookSafely, persistSaleToWorkbook, readWorkbookIds } from "./inventory/workbook-persistence.js";
import { appendInventoryRowsDirectToGoogleSheets, readGoogleSheetAllocationIds, readGoogleSheetInventoryRows, readGoogleSheetSaleIds, writeSaleToGoogleSheets } from "./inventory/google-sheets.js";
import {
  createPendingTransaction,
  getPendingTransaction,
  getPendingTransactionBySourceMessageId,
  getPendingTransactionByPurchaseIdentity,
  listPendingTransactions,
  listContinuationTargets,
  savePendingTransaction,
  createPendingContinuation,
  getPendingContinuation,
  listPendingContinuations,
  removePendingContinuation,
  appendInvoicePage,
  findTransactionByOrderId,
  findTransactionByPageFingerprint,
  findTransactionsByPageDocumentFingerprint,
  findTransactionsByPageFilename,
  findTransactionByPageSimilarity,
  findPendingTransactionByPageSimilarity,
  setTransactionStatus,
  type InvoicePage,
} from "./transaction.js";
import { buildSaleCardKey, buildSelectedLotSalePlan, type SaleDraft } from "./inventory/sales.js";

const token = process.env.DISCORD_TOKEN;
const invoiceChannelId = process.env.INVOICE_CHANNEL_ID;
const purchaseReviewChannelId = process.env.PURCHASE_REVIEW_CHANNEL_ID;

if (!token) throw new Error("DISCORD_TOKEN is missing from .env");
if (!invoiceChannelId) throw new Error("INVOICE_CHANNEL_ID is missing from .env");

const catalogPath = path.resolve("data/catalog.json");
const invoiceTestMode = process.env.INVOICE_TEST_MODE === "true";
const productionInventoryPath = path.resolve("data/inventory.json");
const productionWorkbookPath = process.env.INVENTORY_WORKBOOK_PATH
  ? path.resolve(process.env.INVENTORY_WORKBOOK_PATH)
  : undefined;
const testRuntimePath = path.resolve(".test-runtime");
const inventoryPath = invoiceTestMode
  ? path.join(testRuntimePath, "inventory.json")
  : productionInventoryPath;
const workbookPath = invoiceTestMode
  ? path.join(testRuntimePath, "workbook.xlsx")
  : productionWorkbookPath;

if (invoiceTestMode) {
  await mkdir(testRuntimePath, { recursive: true });
  if (!productionWorkbookPath) {
    throw new Error("INVOICE_TEST_MODE requires INVENTORY_WORKBOOK_PATH so the real workbook can be copied to a temporary test workbook.");
  }
  await copyFile(productionWorkbookPath, workbookPath!);
  await writeFile(inventoryPath, "[]\n", "utf8");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function invoiceHasIdentity(invoice: Awaited<ReturnType<typeof extractInvoice>>): boolean {
  return Boolean(invoice.orderId || invoice.seller || invoice.purchaseDate);
}

function mergeContinuationInvoice(
  target: Awaited<ReturnType<typeof extractInvoice>>,
  continuation: Awaited<ReturnType<typeof extractInvoice>>,
): Awaited<ReturnType<typeof extractInvoice>> {
  return {
    ...target,
    subtotal: target.subtotal ?? continuation.subtotal,
    shipping: target.shipping ?? continuation.shipping,
    tax: target.tax ?? continuation.tax,
    total: target.total ?? continuation.total,
    currency: target.currency ?? continuation.currency,
    uncertainFields: [...target.uncertainFields, ...continuation.uncertainFields],
    lineItems: continuation.lineItems,
  };
}

function invoicePageContentFingerprint(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
): string {
  const normalized = JSON.stringify(invoice.lineItems.map((line) => ({
    productName: line.productName?.trim() ?? null,
    setName: line.setName?.trim() ?? null,
    cardNumber: line.cardNumber?.trim() ?? null,
    condition: line.condition?.trim() ?? null,
    language: line.language?.trim() ?? null,
    variant: line.variant?.trim() ?? null,
    quantity: line.quantity ?? null,
    unitPrice: line.unitPrice ?? null,
    totalPrice: line.totalPrice ?? null,
  })));
  return createHash("sha256").update(normalized).digest("hex");
}

function invoicePageDocumentFingerprint(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
): string {
  const normalized = JSON.stringify({
    seller: invoice.seller?.trim() ?? null,
    purchaseDate: invoice.purchaseDate?.trim() ?? null,
    subtotal: invoice.subtotal ?? null,
    shipping: invoice.shipping ?? null,
    tax: invoice.tax ?? null,
    total: invoice.total ?? null,
    currency: invoice.currency ?? null,
    lineItems: invoice.lineItems.map((line) => ({
      productName: line.productName?.trim() ?? null,
      setName: line.setName?.trim() ?? null,
      cardNumber: line.cardNumber?.trim() ?? null,
      condition: line.condition?.trim() ?? null,
      language: line.language?.trim() ?? null,
      variant: line.variant?.trim() ?? null,
      quantity: line.quantity ?? null,
      unitPrice: line.unitPrice ?? null,
      totalPrice: line.totalPrice ?? null,
    })),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

async function invoicePageFingerprint(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  filePath?: string,
): Promise<string> {
  const hash = createHash("sha256").update(invoicePageContentFingerprint(invoice));
  if (filePath) hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Unknown";
  return `${currency ?? ""} ${amount.toFixed(2)}`.trim();
}

function statusLabel(plan: IngestionPlan): string {
  if (plan.pendingReview > 0 || plan.rows.some((row) => row.input.reviewRequired)) return "⚠️ Manual review recommended";
  if (plan.insertable > 0) return "✅ Ready to store";
  if (plan.skipped > 0) return "ℹ️ Already stored";
  return "ℹ️ Nothing to store";
}

function truncateDiscord(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function embedCharacterCount(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text?.length ?? 0) +
    (data.author?.name?.length ?? 0) +
    (data.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0)
  );
}

function chunkReviewEmbeds(embeds: EmbedBuilder[]): EmbedBuilder[][] {
  const chunks: EmbedBuilder[][] = [];
  let current: EmbedBuilder[] = [];
  let currentSize = 0;
  for (const embed of embeds) {
    const size = embedCharacterCount(embed);
    if (size > 6000) throw new Error(`Invoice review embed exceeds Discord's 6000-character limit (${size}).`);
    if (current.length > 0 && (currentSize + size > 5800 || current.length >= 10)) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(embed);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildReviewEmbeds(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  plan: IngestionPlan,
  transactionId: string,
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  const transactionLabel = transactionId.slice(0, 8);

  const summary = new EmbedBuilder()
    .setTitle("🔎 Invoice Review")
    .setDescription(
      [
        statusLabel(plan),
        "",
        "Every valid purchased line is stored. SKU and catalog resolution are recorded separately and can be completed later.",
      ].join("\n"),
    )
    .addFields(
      { name: "Seller", value: invoice.seller ?? "Unknown", inline: true },
      { name: "Purchase Date", value: invoice.purchaseDate ?? "Unknown", inline: true },
      { name: "Order ID", value: invoice.orderId ?? "Unknown", inline: true },
      { name: "Subtotal", value: formatMoney(invoice.subtotal, invoice.currency), inline: true },
      { name: "Shipping", value: formatMoney(invoice.shipping, invoice.currency), inline: true },
      { name: "Tax", value: formatMoney(invoice.tax, invoice.currency), inline: true },
      { name: "Total", value: formatMoney(invoice.total, invoice.currency), inline: true },
      { name: "Decision", value: `To record: ${plan.insertable} • Needs extraction review: ${plan.pendingReview} • Skipped: ${plan.skipped}`, inline: true },
      { name: "Review flags", value: String(plan.rows.filter((row) => row.input.reviewRequired).length), inline: true },
    )
    .setFooter({ text: `Transaction ${transactionLabel} • Pending confirmation` });

  if (invoice.uncertainFields.length > 0) {
    summary.addFields({
      name: "⚠️ Extraction uncertainty",
      value: invoice.uncertainFields.join(", ").slice(0, 1024),
    });
  }

  embeds.push(summary);

  for (let start = 0; start < plan.rows.length; start += 4) {
    const cardEmbed = new EmbedBuilder()
      .setTitle(start === 0 ? "Proposed Inventory" : "Proposed Inventory — continued")
      .setFooter({ text: `Transaction ${transactionLabel} • ${plan.rows.length} invoice lines` });

    plan.rows.slice(start, start + 4).forEach((row, offset) => {
      const index = start + offset + 1;
      const details = [
        `Set: ${row.input.setSeries || "Unknown"}`,
        `Card No.: ${row.input.cardNumber || "Unknown"}`,
        `Condition: ${row.input.condition || "Unknown"}`,
        `Variant: ${row.input.variantPrinting || "Unknown"}`,
        `Qty: ${row.input.qtyPurchased ?? "?"}`,
        `Unit: ${formatMoney(row.input.unitCost ?? null, invoice.currency)}`,
        `SKU: ${row.skuId ?? "UNRESOLVED (purchase still recorded)"}`,
        row.input.reviewRequired
          ? `⚠️ REVIEW REQUIRED: ${(row.input.reviewFlags ?? []).join(", ")}`
          : "Review: clear",
      ].join("\n");

      cardEmbed.addFields({
        name: truncateDiscord(
          `${index}. ${row.input.cardName || "Unknown card"} — ${row.input.rarity || "Rarity unknown"} — ${row.input.cardNumber || "Card No. unknown"} — ${row.input.variantPrinting || "Variant unknown"} — ${row.action}`,
          256,
        ),
        value: truncateDiscord(
          `${details}${row.input.reviewNotes?.length ? `\nNotes: ${row.input.reviewNotes.join(" ").slice(0, 500)}` : ""}\n\nReason: ${row.reasons.join(" ").slice(0, 700)}`,
          1024,
        ),
        inline: false,
      });
    });

    embeds.push(cardEmbed);
  }

  return embeds;
}

function reviewButtons(transactionId: string, canConfirm: boolean, needsReview: boolean) {
  const buttons = new ActionRowBuilder<ButtonBuilder>();

  if (needsReview) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`invoice:review:${transactionId}`)
        .setLabel("Review Now")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`invoice:later:${transactionId}`)
        .setLabel("Review Later")
        .setStyle(ButtonStyle.Secondary),
    );
  } else {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(`invoice:confirm:${transactionId}`)
        .setLabel(canConfirm ? "Confirm & Store" : "Confirm & Store (blocked)")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canConfirm),
    );
  }

  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(`invoice:reject:${transactionId}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  return buttons;
}

function reviewActionButtons(transaction: NonNullable<ReturnType<typeof getPendingTransaction>>) {
  const needsReview = transaction.plan.rows.some((row) => row.input.reviewRequired);
  return reviewButtons(
    transaction.id,
    transaction.plan.insertable > 0 && !needsReview,
    needsReview,
  );
}

function buildPendingReviewMenu() {
  const transactions = listPendingTransactions().slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("invoice:review-select")
    .setPlaceholder("Select an invoice");

  for (const transaction of transactions) {
    const invoice = transaction.invoice;
    const label = (invoice.orderId || invoice.seller || ("Invoice " + transaction.id.slice(0, 8))).slice(0, 100);
    const description = ((transaction.status.replaceAll("_", " ")) + " • " + transaction.plan.rows.length + " line(s) • " + transaction.pages.length + " page(s)").slice(0, 100);
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setDescription(description)
        .setValue(transaction.id),
    );
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function getPurchaseReviewChannel() {
  if (!purchaseReviewChannelId) return null;
  const channel = await client.channels.fetch(purchaseReviewChannelId);
  if (!channel || !channel.isSendable() || channel.isDMBased()) {
    throw new Error(`PURCHASE_REVIEW_CHANNEL_ID ${purchaseReviewChannelId} is not a usable Discord text channel.`);
  }
  return channel as TextChannel;
}

function buildContinuationMenu(continuationId: string) {
  const transactions = listContinuationTargets().slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`invoice:continuation-select:${continuationId}`)
    .setPlaceholder("Select the invoice this page belongs to");

  for (const transaction of transactions) {
    const invoice = transaction.invoice;
    const status = transaction.status.replaceAll("_", " ");
    const label = (invoice.orderId || invoice.seller || ("Invoice " + transaction.id.slice(0, 8))).slice(0, 100);
    const description = (
      `${status} • ${transaction.plan.rows.length} card line(s) • ${transaction.pages.length} page(s)`
    ).slice(0, 100);
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setDescription(description)
        .setValue(transaction.id),
    );
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildCardNumberModal(
  transactionId: string,
  rowIndex: number,
  cardName: string,
  setName: string,
  rarity: string,
  variant: string,
  currentValue: string,
) {
  const input = new TextInputBuilder()
    .setCustomId("card-number")
    .setLabel("Valid card number")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: 006, 088, 176")
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);

  if (currentValue !== "1") {
    input.setValue(currentValue);
  }

  return new ModalBuilder()
    .setCustomId(`invoice:card-number:${transactionId}:${rowIndex}`)
    .setTitle(`${cardName} — ${setName} — ${rarity}/${variant}`.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

interface PendingSale {
  id: string;
  draft: SaleDraft;
  saleId: string;
  allocations: Array<{ inventoryId: string; qty: number; unitCost: number }>;
  selectedRemainingQty: number;
  createdAt: number;
}

const pendingSales = new Map<string, PendingSale>();
let salePersistenceLock: Promise<void> = Promise.resolve();

async function withSalePersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = salePersistenceLock;
  let release!: () => void;
  salePersistenceLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

// Search results are cached briefly so selecting a result can open the Discord
// modal immediately. Discord gives component interactions only a short response
// window, while Google Sheets reads can exceed it.
const pendingSaleSelections = new Map<string, { row: ReturnType<typeof readV2InventoryWorkbook>["rows"][number]; expiresAt: number }>();
const SALE_SELECTION_TTL_MS = 10 * 60 * 1000;

function buildSaleEntryModal(row: ReturnType<typeof readV2InventoryWorkbook>["rows"][number]) {
  const quantity = new TextInputBuilder()
    .setCustomId("sale-quantity")
    .setLabel("Quantity sold")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: 1")
    .setRequired(true)
    .setMaxLength(6);
  const price = new TextInputBuilder()
    .setCustomId("sale-price")
    .setLabel("Sell price per card (PHP)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: 150")
    .setRequired(true)
    .setMaxLength(12);
  const date = new TextInputBuilder()
    .setCustomId("sale-date")
    .setLabel("Date sold (YYYY-MM-DD)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(new Date().toISOString().slice(0, 10))
    .setRequired(true)
    .setMaxLength(10)
    .setValue(new Date().toISOString().slice(0, 10));
  const notes = new TextInputBuilder()
    .setCustomId("sale-notes")
    .setLabel("Notes (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  return new ModalBuilder()
    .setCustomId("sale:entry:" + row.inventoryId)
    .setTitle("Record Sale — " + row.cardName.slice(0, 30))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(quantity),
      new ActionRowBuilder<TextInputBuilder>().addComponents(price),
      new ActionRowBuilder<TextInputBuilder>().addComponents(date),
      new ActionRowBuilder<TextInputBuilder>().addComponents(notes),
    );
}

function buildSaleSearchModal() {
  const input = new TextInputBuilder()
    .setCustomId("sale-search")
    .setLabel("Search inventory")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Card name, set, number, rarity, SKU, etc.")
    .setRequired(false)
    .setMaxLength(100);

  return new ModalBuilder()
    .setCustomId("sale:search")
    .setTitle("Find Inventory for Sale")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function buildSaleInventoryMenu(rows: ReturnType<typeof readV2InventoryWorkbook>["rows"], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const available = rows
    .filter((row) => row.remainingQty > 0)
    .map((row) => {
      const haystack = [
        row.inventoryId,
        row.rawCardKey,
        row.cardName,
        row.setSeries,
        row.cardNumber,
        row.rarity,
        row.condition,
        row.language,
        row.variantPrinting,
      ].filter(Boolean).join(" ").toLowerCase();
      const matches = tokens.every((token) => haystack.includes(token));
      const exactBoost = haystack.includes(normalizedQuery) ? 100 : 0;
      const nameBoost = row.cardName.toLowerCase().includes(normalizedQuery) ? 50 : 0;
      return { row, matches, score: exactBoost + nameBoost };
    })
    .filter((candidate) => candidate.matches)
    .sort((a, b) => b.score - a.score || a.row.cardName.localeCompare(b.row.cardName))
    .slice(0, 25)
    .map((candidate) => candidate.row);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("sale:inventory-select")
    .setPlaceholder(available.length ? "Select the inventory record to sell" : "No matching inventory");

  for (const row of available) {
    const rarity = row.rarity || "Rarity not set";
    const variant = row.variantPrinting || "Normal";
    const label = `${row.cardName} — ${row.cardNumber}`.slice(0, 100);
    const description = [
      row.setSeries,
      rarity,
      variant,
      row.condition,
      `Available: ${row.remainingQty}`,
    ].join(" • ").slice(0, 100);

    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setDescription(description)
        .setValue(row.inventoryId),
    );
  }

  return {
    available,
    row: new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
  };
}

async function loadCatalog(): Promise<Catalog> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
}

async function saveCatalog(catalog: Catalog): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

function workbookRateForInvoice(invoice: Awaited<ReturnType<typeof extractInvoice>>): number | undefined {
  if (invoice.currency === "PHP") return 1;
  if (invoice.currency === "USD") {
    const raw = process.env.WORKBOOK_USD_TO_PHP_RATE;
    if (!raw) return undefined;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("WORKBOOK_USD_TO_PHP_RATE must be a positive number.");
    return rate;
  }
  throw new Error(`No workbook currency conversion is configured for invoice currency ${invoice.currency ?? "unknown"}.`);
}

async function persistWorkbookIfConfigured(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  plan: IngestionPlan,
): Promise<string | null> {
  if (!workbookPath) return null;
  if (!existsSync(workbookPath)) throw new Error(`Configured workbook does not exist: ${workbookPath}`);
  if (plan.insertable === 0) return `Workbook unchanged — no new inventory lines to insert.`;

  const rate = workbookRateForInvoice(invoice);
  if (rate === undefined) {
    throw new Error(
      "Workbook persistence is configured, but WORKBOOK_USD_TO_PHP_RATE is missing. " +
      "The workbook stores PHP costs and the invoice is in USD; refusing to guess the FX rate.",
    );
  }

  const result = persistInvoicePlanToWorkbookSafely(workbookPath, plan, invoice, {
    unitCostRate: rate,
    sourceCurrency: invoice.currency ?? undefined,
  });
  return `Workbook updated: ${result.inserted} inserted, ${result.skipped} skipped, ${result.pendingReview} pending.`;
}

async function persistGoogleSheetsIfConfigured(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  plan: IngestionPlan,
): Promise<string | null> {
  if (process.env.GOOGLE_SHEETS_SYNC !== "true") return null;
  if (invoiceTestMode) return "Google Sheets sync skipped in INVOICE_TEST_MODE.";
  const rate = workbookRateForInvoice(invoice);
  if (rate === undefined) {
    throw new Error("Google Sheets sync is configured, but WORKBOOK_USD_TO_PHP_RATE is missing; refusing to guess the FX rate.");
  }

  const rows = invoicePlanToWorkbookRows(plan, invoice, {
    unitCostRate: rate,
    sourceCurrency: invoice.currency ?? undefined,
  });

  if (rows.length === 0) return "Google Sheets unchanged — no new inventory lines to insert.";

  // invoicePlanToWorkbookRows keeps the source unit cost so the XLSX
  // persistence layer can apply the conversion and record the FX note.
  // Google Sheets receives already-persisted PHP values directly, so convert
  // the Unit Cost here as well; Total Cost is already converted above.
  const googleRows = rows.map((row) => ({
    ...row,
    unitCost: (row.unitCost ?? 0) * rate,
  }));

  const result = await appendInventoryRowsDirectToGoogleSheets(googleRows);
  return `Google Sheets updated: ${result.inserted} inserted, ${result.skipped} already present.`;
}

async function buildPlan(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  sourceMessageId: string,
  catalog: Catalog,
  sourceLineOffset = 0,
): Promise<{ catalog: Catalog; plan: IngestionPlan }> {
  const store = await createJsonInventoryStore(inventoryPath);
  let workingCatalog = catalog;
  const existingKeys = new Set<string>();
  for (const row of store.list()) {
    existingKeys.add(row.inventoryId);
    const sourceLine = row.sourceLine ?? Number(row.inventoryId.match(/-(\d+)$/)?.[1] ?? NaN);
    if (Number.isInteger(sourceLine) && sourceLine > 0) {
      for (const key of purchaseIdentityKeys({ ...row, sourceLine })) {
        existingKeys.add(key);
      }
    }
  }
  let plan = planInvoiceIngestion(
    workingCatalog,
    invoice,
    sourceMessageId,
    existingKeys,
    { allowMissingCardNumber: true, sourceLineOffset },
  );

  const runtime = new TCGdexRuntime();
  let enriched = false;

  for (const row of plan.rows.filter(
    (candidate) => candidate.action === "INSERT" && candidate.state === "UNMATCHED",
  )) {
    const result = await enrichCardInput(
      workingCatalog,
      {
        name: row.input.cardName,
        setName: row.input.setSeries,
        cardNumber: row.input.cardNumber,
        language: row.input.language,
        variant: row.input.variantPrinting,
        condition: row.input.condition,
      },
      runtime,
    );

    // A unique runtime candidate is sufficient to establish the card's
    // printing identity even when no local SKU can be created (for example,
    // a known printing with an unsupported variant). Keep that catalog data
    // so the second planning pass can fill the required Card Number safely.
    if (result.catalog && result.externalCandidates.length === 1) {
      workingCatalog = mergeCatalog(workingCatalog, result.catalog);
      enriched = true;
    }
  }

  plan = planInvoiceIngestion(
    workingCatalog,
    invoice,
    sourceMessageId,
    existingKeys,
    { allowMissingCardNumber: true, sourceLineOffset },
  );

  if (enriched) await saveCatalog(workingCatalog);
  return { catalog: workingCatalog, plan };
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log("Logged in as " + readyClient.user.tag);
  console.log("Inventory persistence: " + inventoryPath);

  for (const guild of readyClient.guilds.cache.values()) {
    const commands = await readyClient.application.commands.fetch({ guildId: guild.id });
    const existingReview = commands.find((command) => command.name === "review");
    const reviewCommand = {
      name: "review",
      description: "Open an invoice for review or continuation",
    };
    if (existingReview) await existingReview.edit(reviewCommand);
    else await readyClient.application.commands.create(reviewCommand, guild.id);

    const existingSale = commands.find((command) => command.name === "sale");
    const saleCommand = {
      name: "sale",
      description: "Find an inventory card and start a sale",
    };
    if (existingSale) await existingSale.edit(saleCommand);
    else await readyClient.application.commands.create(saleCommand, guild.id);
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || message.channelId !== invoiceChannelId || message.attachments.size === 0) return;

  const imageAttachments = [...message.attachments.values()].filter(
    (attachment) => attachment.contentType?.startsWith("image/"),
  );

  if (imageAttachments.length === 0) {
    await message.reply("I found no image attachments in that message.");
    return;
  }

  for (const attachment of imageAttachments) {
    try {
      const filePath = await downloadInvoice(attachment);
      await message.reply(`📥 Invoice received. Extracting and resolving **${attachment.name ?? "invoice"}**...`);

      const invoice = await extractInvoice(filePath);

      const catalog = await loadCatalog();
      const sourceMessageId = `DISCORD-${message.id}-${attachment.id}`;
      const fingerprint = await invoicePageFingerprint(invoice, filePath);
      const contentFingerprint = invoicePageContentFingerprint(invoice);
      const documentFingerprint = invoicePageDocumentFingerprint(invoice);
      const existingPage = findTransactionByPageFingerprint(fingerprint);
      if (existingPage) {
        await message.reply(`This invoice page was already processed for **${existingPage.invoice.orderId || existingPage.id.slice(0, 8)}**. No cards were added.`);
        continue;
      }
      const documentIdentityAvailable = Boolean(invoice.seller || invoice.purchaseDate || invoice.total !== null || invoice.subtotal !== null);
      if (documentIdentityAvailable) {
        const documentMatches = findTransactionsByPageDocumentFingerprint(documentFingerprint);
        if (documentMatches.length === 1) {
          const duplicateTransaction = documentMatches[0];
          await message.reply(`This invoice page matches an already processed page for **${duplicateTransaction.invoice.orderId || duplicateTransaction.id.slice(0, 8)}**. No cards were added.`);
          continue;
        }
      }
      const existingTransaction = getPendingTransactionBySourceMessageId(sourceMessageId);
      if (existingTransaction) {
        await message.reply(`This invoice is already pending review (Transaction ${existingTransaction.id.slice(0, 8)}). Use **Review Now** or **Review Later** on the existing ticket.`);
        continue;
      }

      const resolved = await buildPlan(invoice, sourceMessageId, catalog);

      // If OCR or file-content fingerprints change, the original attachment
      // filename can still provide a useful duplicate signal. This includes
      // STORED history so a re-upload cannot revive a completed transaction.
      // Shared/generic filenames are treated as ambiguous and never guessed.
      const attachmentName = attachment.name ?? "invoice";
      const filenameDuplicateCandidates = findTransactionsByPageFilename(
        attachmentName,
        invoice.lineItems.length,
      );

      if (filenameDuplicateCandidates.length === 1) {
        const filenameDuplicate = filenameDuplicateCandidates[0];
        const label = filenameDuplicate.invoice.orderId || filenameDuplicate.id.slice(0, 8);
        if (filenameDuplicate.status === "STORED") {
          await message.reply(
            "This invoice page matches an already stored invoice **" + label + "** by attachment filename. No cards were added.",
          );
        } else {
          await message.reply(
            "This invoice page matches the existing pending invoice **" + label + "** by attachment filename. No cards were added. Use **/review** to reopen the existing invoice.",
          );
        }
        continue;
      }

      if (filenameDuplicateCandidates.length > 1) {
        await message.reply(
          "This attachment filename matches **" +
          filenameDuplicateCandidates.length +
          "** existing invoices, so I won't guess which one it belongs to. Use **/review** to select the correct invoice instead. No cards were added.",
        );
        continue;
      }

      // OCR can lose invoice identity fields on a re-upload. Before treating
      // such a page as a continuation, compare its complete extracted line
      // set against each existing page of pending invoices. Only a unique
      // complete-page match is considered a duplicate; ambiguous matches are
      // left for explicit continuation selection instead of guessing.
      const similarPendingTransaction = !invoiceHasIdentity(invoice)
        ? findPendingTransactionByPageSimilarity(resolved.plan)
        : undefined;
      if (similarPendingTransaction) {
        await message.reply(
          `This invoice page matches the existing pending invoice **${similarPendingTransaction.invoice.orderId || similarPendingTransaction.id.slice(0, 8)}**. No cards were added. Use **/review** to reopen the existing invoice.`,
        );
        continue;
      }

      // Before treating a matching order ID as a continuation, make sure the
      // incoming page is not a re-upload of an existing page. This also covers
      // stored invoices where file/document fingerprints may differ between scans.
      const similarProcessedTransaction = findTransactionByPageSimilarity(resolved.plan);
      if (similarProcessedTransaction) {
        await message.reply(
          `This invoice page matches an already processed page for **${similarProcessedTransaction.invoice.orderId || similarProcessedTransaction.id.slice(0, 8)}**. No cards were added.`,
        );
        continue;
      }

      const matchingOrderTransaction = invoice.orderId ? findTransactionByOrderId(invoice.orderId) : undefined;
      if (matchingOrderTransaction) {
        const fingerprint = await invoicePageFingerprint(invoice, filePath);
        const duplicate = matchingOrderTransaction.pages.some((page) =>
          page.fingerprint === fingerprint ||
          (page.contentFingerprint && page.contentFingerprint === contentFingerprint)
        );
        if (duplicate) {
          await message.reply("This invoice page was already attached to **" + (matchingOrderTransaction.invoice.orderId || matchingOrderTransaction.id.slice(0, 8)) + "**. No cards were added.");
          continue;
        }
        const mergedInvoice = mergeContinuationInvoice(matchingOrderTransaction.invoice, invoice);
        const continuationPlan = await buildPlan(mergedInvoice, sourceMessageId, matchingOrderTransaction.catalog, matchingOrderTransaction.plan.rows.length);
        const page: InvoicePage = {
          id: sourceMessageId,
          sourceMessageId,
          attachmentName: attachment.name ?? "invoice",
          receivedAt: new Date().toISOString(),
          fingerprint,
          contentFingerprint,
          documentFingerprint,
          lineCount: invoice.lineItems.length,
        };
        matchingOrderTransaction.catalog = continuationPlan.catalog;
        appendInvoicePage(matchingOrderTransaction, page, continuationPlan.plan, mergedInvoice);
        await message.reply("Continuation attached to **" + (matchingOrderTransaction.invoice.orderId || matchingOrderTransaction.id.slice(0, 8)) + "**. The invoice now has **" + matchingOrderTransaction.plan.rows.length + "** card lines across **" + matchingOrderTransaction.pages.length + "** page(s).");
        continue;
      }

      const existingPurchaseTransaction = getPendingTransactionByPurchaseIdentity(resolved.plan);
      if (existingPurchaseTransaction) {
        await message.reply(
          `This invoice is already pending review (Transaction ${existingPurchaseTransaction.id.slice(0, 8)}). Use **/review** to reopen the existing ticket instead of creating another pending transaction.`,
        );
        continue;
      }

      const continuationCandidates = listContinuationTargets();
      if (!invoiceHasIdentity(invoice) && invoice.lineItems.length > 0) {
        const fingerprint = await invoicePageFingerprint(invoice, filePath);
        const duplicateContinuation = listPendingContinuations().some((pending) => pending.fingerprint === fingerprint);
        if (duplicateContinuation) {
          await message.reply("This continuation page is already waiting for invoice selection. No cards were added.");
          continue;
        }

        createPendingContinuation({
          id: sourceMessageId,
          sourceMessageId,
          attachmentName: attachment.name ?? "invoice",
          receivedAt: new Date().toISOString(),
          fingerprint,
          contentFingerprint,
          documentFingerprint,
          invoice,
          catalog: resolved.catalog,
          plan: resolved.plan,
        });

        const reviewChannel = await getPurchaseReviewChannel();
        const reviewDestination = reviewChannel ?? (message.channel as TextChannel);
        if (reviewChannel) {
          await message.reply(`📄 Continuation page received. The purchase-review selector was posted in <#${purchaseReviewChannelId}>.`);
        }
        await reviewDestination.send({
          content: continuationCandidates.length > 0
            ? [
                "📄 **Continuation page detected**",
                "No invoice identity was found on this page. It contains **" + invoice.lineItems.length + "** card line(s).",
                "Select the invoice this page belongs to below. The page will not be added until you select one.",
              ].join("\n")
            : [
                "📄 **Unassigned continuation page held**",
                "No invoice identity was found and there are currently no invoices available to attach it to.",
                "No cards were added. Use **/review** after the parent invoice has been uploaded so you can attach this page.",
              ].join("\n"),
          components: continuationCandidates.length > 0 ? [buildContinuationMenu(sourceMessageId)] : [],
        });
        continue;
      }

      const transaction = createPendingTransaction(
        invoice,
        sourceMessageId,
        [attachment.name ?? "invoice"],
        resolved.catalog,
        resolved.plan,
        {
          id: sourceMessageId,
          sourceMessageId,
          attachmentName: attachment.name ?? "invoice",
          receivedAt: new Date().toISOString(),
          fingerprint: await invoicePageFingerprint(invoice, filePath),
          contentFingerprint,
          documentFingerprint,
          lineCount: invoice.lineItems.length,
        },
      );

      const reviewEmbeds = buildReviewEmbeds(invoice, resolved.plan, transaction.id);
      const reviewEmbedChunks = chunkReviewEmbeds(reviewEmbeds);
      const reviewChannel = await getPurchaseReviewChannel();
      const reviewDestination = reviewChannel ?? (message.channel as TextChannel);

      if (reviewChannel) {
        await message.reply(`📥 Invoice received. The purchase review for **${invoice.orderId || transaction.id.slice(0, 8)}** was posted in <#${purchaseReviewChannelId}>.`);
      }

      for (let index = 0; index < reviewEmbedChunks.length; index += 1) {
        const isLastChunk = index === reviewEmbedChunks.length - 1;
        await reviewDestination.send({
          content: index === 0
            ? `🧾 **Purchase Review** — invoice ${invoice.orderId || transaction.id.slice(0, 8)}`
            : undefined,
          embeds: reviewEmbedChunks[index],
          components: isLastChunk
            ? [reviewButtons(transaction.id, resolved.plan.insertable > 0 && !resolved.plan.rows.some((row) => row.input.reviewRequired), resolved.plan.rows.some((row) => row.input.reviewRequired))]
            : [],
        });
      }

      console.log("Invoice extracted, resolved, and awaiting confirmation:", transaction.id);
    } catch (error) {
      console.error("Failed to process invoice:", error);
      await message.reply("I received the invoice image, but I couldn't process it. Check the bot logs for details.");
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "sale") {
    if (!workbookPath) {
      await interaction.reply({ content: "Sales search is not configured because INVENTORY_WORKBOOK_PATH is missing.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.showModal(buildSaleSearchModal());
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "sale:search") {
    if (!workbookPath) {
      await interaction.reply({ content: "Sales search is not configured because INVENTORY_WORKBOOK_PATH is missing.", flags: MessageFlags.Ephemeral });
      return;
    }

    const query = interaction.fields.getTextInputValue("sale-search").trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const rows = process.env.GOOGLE_SHEETS_SYNC === "true" && !invoiceTestMode
        ? await readGoogleSheetInventoryRows()
        : readV2InventoryWorkbook(workbookPath).rows;
      const { available, row } = buildSaleInventoryMenu(rows, query);

      if (available.length === 0) {
        await interaction.editReply({
          content: query
            ? `No available inventory records matched **${query}**. Search by card name, set, card number, rarity, condition, variant, or Inventory ID.`
            : "There is no available inventory to sell.",
        });
        return;
      }

      const now = Date.now();
      for (const [key, value] of pendingSaleSelections) {
        if (value.expiresAt <= now) pendingSaleSelections.delete(key);
      }
      for (const selectedRow of available) {
        pendingSaleSelections.set(selectedRow.inventoryId, { row: selectedRow, expiresAt: now + SALE_SELECTION_TTL_MS });
      }

      await interaction.editReply({
        content: [
          query ? `Search results for **${query}**:` : "Available inventory:",
          available.length === 25 ? "Showing the first 25 matches." : `Found **${available.length}** matching record(s).`,
          "Select the exact inventory record below to continue the sale.",
        ].join("\n"),
        components: [row],
      });
    } catch (error) {
      console.error("Failed to search inventory for sale:", error);
      const message = error instanceof Error ? error.message : String(error);
      const hint = message.includes("credentials file") || message.includes("service account credentials")
        ? "\n\nGoogle Sheets is enabled, but the service-account credentials are missing or invalid. Check GOOGLE_SERVICE_ACCOUNT_JSON_PATH in .env."
        : "";
      await interaction.editReply({ content: "I couldn't read the Inventory sheet right now." + hint });
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("sale:entry:")) {
    if (!workbookPath) {
      await interaction.reply({ content: "Sales are not configured because INVENTORY_WORKBOOK_PATH is missing.", flags: MessageFlags.Ephemeral });
      return;
    }

    const inventoryId = interaction.customId.slice("sale:entry:".length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const rows = process.env.GOOGLE_SHEETS_SYNC === "true" && !invoiceTestMode
        ? await readGoogleSheetInventoryRows()
        : readV2InventoryWorkbook(workbookPath).rows;
      const selected = rows.find((row) => row.inventoryId === inventoryId && row.remainingQty > 0);
      if (!selected) {
        await interaction.editReply({ content: "That inventory record is no longer available. Run **/sale** again." });
        return;
      }

      const quantityText = interaction.fields.getTextInputValue("sale-quantity").trim();
      const priceText = interaction.fields.getTextInputValue("sale-price").trim().replace(/[,₱$]/g, "");
      const dateSold = interaction.fields.getTextInputValue("sale-date").trim();
      const notes = interaction.fields.getTextInputValue("sale-notes").trim();
      const qtySold = Number(quantityText);
      const sellPrice = Number(priceText);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateSold) || Number.isNaN(Date.parse(dateSold))) {
        await interaction.editReply({ content: "Date sold must use **YYYY-MM-DD**." });
        return;
      }
      if (!Number.isInteger(qtySold) || qtySold < 1) {
        await interaction.editReply({ content: "Quantity sold must be a positive whole number." });
        return;
      }
      if (!Number.isFinite(sellPrice) || sellPrice < 0) {
        await interaction.editReply({ content: "Sell price must be a non-negative PHP amount." });
        return;
      }

      const draft: SaleDraft = {
        cardKey: buildSaleCardKey({
          cardKey: "",
          inventoryId: selected.inventoryId,
          cardName: selected.cardName,
          setSeries: selected.setSeries,
          cardNumber: selected.cardNumber,
          rarity: selected.rarity,
          condition: selected.condition,
          language: selected.language,
          variantPrinting: selected.variantPrinting,
          dateSold: "",
          qtySold: 1,
          sellPrice: 0,
        }),
        inventoryId: selected.inventoryId,
        cardName: selected.cardName,
        setSeries: selected.setSeries,
        cardNumber: selected.cardNumber,
        rarity: selected.rarity,
        condition: selected.condition,
        language: selected.language,
        variantPrinting: selected.variantPrinting,
        dateSold,
        qtySold,
        sellPrice,
        notes,
      };
      // The selected inventory record is the authoritative lot for this sale.
      // Allocation stays inside that lot; it never spills into another acquisition lot.
      const saleIds = process.env.GOOGLE_SHEETS_SYNC === "true" && !invoiceTestMode
        ? await readGoogleSheetSaleIds()
        : readWorkbookIds(workbookPath!, 4, "SALE");
      const salePlan = buildSelectedLotSalePlan(rows, draft, saleIds);
      const pendingId = salePlan.saleId + "-" + Date.now().toString(36);
      pendingSales.set(pendingId, {
        id: pendingId,
        draft,
        saleId: salePlan.saleId,
        allocations: salePlan.allocations,
        selectedRemainingQty: selected.remainingQty,
        createdAt: Date.now(),
      });

      const totalRevenue = qtySold * sellPrice;
      const estimatedCost = salePlan.allocations.reduce((sum, allocation) => sum + allocation.qty * allocation.unitCost, 0);
      const allocationSummary = salePlan.allocations.map((allocation) =>
        allocation.inventoryId + " × " + allocation.qty + " @ ₱" + allocation.unitCost.toFixed(2)
      ).join("\n");
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("sale:confirm:" + pendingId).setLabel("Confirm Sale").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("sale:cancel:" + pendingId).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({
        content: [
          "🧾 **Sale Review**",
          "",
          "**" + selected.cardName + " — " + selected.cardNumber + "**",
          selected.setSeries + " • " + (selected.rarity || "Rarity not set") + " • " + (selected.variantPrinting || "Normal"),
          selected.condition + " • " + selected.language,
          "Inventory: **" + selected.inventoryId + "**",
          "",
          "Date sold: **" + dateSold + "**",
          "Quantity: **" + qtySold + "**",
          "Sell price: **₱" + sellPrice.toFixed(2) + " each**",
          "Revenue: **₱" + totalRevenue.toFixed(2) + "**",
          "Inventory cost preview: **₱" + estimatedCost.toFixed(2) + "**",
          "",
          "Selected inventory lot allocation:",
          allocationSummary,
          notes ? "\nNotes: " + notes : "",
          "",
          "Confirming will write the Sale Log row and Cost Allocation for this selected inventory lot only.",
        ].join("\n"),
        components: [confirmRow],
      });
    } catch (error) {
      console.error("Failed to prepare sale:", error);
      const message = error instanceof Error ? error.message : String(error);
      const userMessage = message.includes("unit(s) remain in the selected inventory lot")
        ? message
        : "I couldn't prepare that sale. Please try the sale again.";
      await interaction.editReply({
        content: "❌ **Sale could not be prepared**\n\n" + userMessage,
      });
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "sale:inventory-select") {
    const inventoryId = interaction.values[0];

    if (!workbookPath) {
      await interaction.update({ content: "Sales search is not configured because INVENTORY_WORKBOOK_PATH is missing.", components: [] });
      return;
    }

    try {
      const cached = pendingSaleSelections.get(inventoryId);
      pendingSaleSelections.delete(inventoryId);
      if (!cached || cached.expiresAt <= Date.now()) {
        await interaction.update({ content: "That search result has expired. Search again with **/sale**.", components: [] });
        return;
      }
      const selected = cached.row;

      const details = [
        "**Selected Inventory**",
        "",
        `**${selected.cardName} — ${selected.cardNumber}**`,
        `${selected.setSeries} • ${selected.rarity || "Rarity not set"} • ${selected.variantPrinting || "Normal"}`,
        `${selected.condition} • ${selected.language}`,
        "",
        `Inventory ID: **${selected.inventoryId}**`,
        `Available: **${selected.remainingQty}**`,
        `Unit Cost: **₱${selected.unitCost.toFixed(2)}**`,
        "",
        "The sale-entry dialogue will use this inventory record. Quantity and sell price will be entered next.",
      ].join("\n");

      // Do not perform a Google Sheets read before showModal(). The component
      // interaction can expire while waiting for Sheets; the entry modal will
      // re-read and validate the lot when the user submits it.
      await interaction.showModal(buildSaleEntryModal(selected));
    } catch (error) {
      console.error("Failed to open selected inventory record:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.update({ content: "I couldn't open that inventory record. Search again with **/sale**.", components: [] });
      }
    }
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "review") {
    const transactions = listPendingTransactions();
    const continuations = listPendingContinuations();
    if (transactions.length === 0 && continuations.length === 0) {
      await interaction.reply({ content: "There are no pending invoice reviews or unassigned continuation pages.", flags: MessageFlags.Ephemeral });
      return;
    }

    const shown = transactions.slice(0, 25);
    const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
    const notices: string[] = [];
    if (shown.length > 0) {
      components.push(buildPendingReviewMenu());
      notices.push(
        shown.length < transactions.length
          ? "Select an invoice below. Showing the first " + shown.length + " of " + transactions.length + "."
          : "Select an invoice below.",
      );
    }
    if (continuations.length > 0 && listContinuationTargets().length > 0) {
      for (const continuation of continuations.slice(0, 4)) {
        components.push(buildContinuationMenu(continuation.id));
      }
      notices.push(
        continuations.length === 1
          ? "You also have **1 unassigned continuation page** waiting for invoice selection."
          : continuations.length > 4
            ? "You also have **" + continuations.length + " unassigned continuation pages**. Showing selectors for the first 4; attach those before reopening /review for the rest."
            : "You also have **" + continuations.length + " unassigned continuation pages** waiting for invoice selection.",
      );
    }

    await interaction.reply({
      content: notices.join("\n"),
      components,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "invoice:review-select") {
    const transactionId = interaction.values[0];
    const transaction = getPendingTransaction(transactionId);
    if (!transaction) {
      await interaction.update({ content: "That invoice is no longer pending.", components: [] });
      return;
    }

    try {
      const reviewEmbedChunks = chunkReviewEmbeds(
        buildReviewEmbeds(transaction.invoice, transaction.plan, transaction.id),
      );

      await interaction.update({
        content: "Pending invoice " + transaction.id.slice(0, 8),
        embeds: reviewEmbedChunks[0],
        components: reviewEmbedChunks.length === 1
          ? [reviewActionButtons(transaction)]
          : [],
      });

      for (let index = 1; index < reviewEmbedChunks.length; index += 1) {
        const isLastChunk = index === reviewEmbedChunks.length - 1;
        await interaction.followUp({
          content: isLastChunk ? undefined : "Invoice review - continued",
          embeds: reviewEmbedChunks[index],
          components: isLastChunk ? [reviewActionButtons(transaction)] : [],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      console.error("Failed to display invoice review:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "I couldn't display this invoice review because the review payload was too large. The invoice is still pending; use /review again.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("invoice:continuation-select:")) {
    const continuationId = interaction.customId.split(":")[2];
    const transactionId = interaction.values[0];
    const continuation = getPendingContinuation(continuationId);
    const transaction = getPendingTransaction(transactionId);

    if (!continuation) {
      await interaction.update({
        content: "That continuation page is no longer waiting for invoice selection.",
        components: [],
      });
      return;
    }

    if (!transaction) {
      await interaction.update({
        content: "That invoice is no longer available for continuation.",
        components: [],
      });
      return;
    }

    const duplicate = transaction.pages.some((page) => page.fingerprint === continuation.fingerprint);
    if (duplicate) {
      removePendingContinuation(continuationId);
      await interaction.update({
        content: "This continuation page was already attached to the selected invoice. No cards were added.",
        components: [],
      });
      return;
    }

    await interaction.deferUpdate();

    try {
      const mergedInvoice = mergeContinuationInvoice(transaction.invoice, continuation.invoice);
      const resolved = await buildPlan(
        mergedInvoice,
        continuation.sourceMessageId,
        transaction.catalog,
        transaction.plan.rows.length,
      );

      const page: InvoicePage = {
        id: continuation.id,
        sourceMessageId: continuation.sourceMessageId,
        attachmentName: continuation.attachmentName,
        receivedAt: continuation.receivedAt,
        fingerprint: continuation.fingerprint,
        contentFingerprint: continuation.contentFingerprint,
        documentFingerprint: continuation.documentFingerprint,
        lineCount: continuation.invoice.lineItems.length,
      };

      transaction.catalog = resolved.catalog;
      appendInvoicePage(transaction, page, resolved.plan, mergedInvoice);
      removePendingContinuation(continuationId);

      await interaction.editReply({
        content: [
          "✅ **Continuation attached**",
          "",
          "Invoice: " + (transaction.invoice.orderId || transaction.id.slice(0, 8)),
          "Status: **" + transaction.status.replaceAll("_", " ") + "**",
          "Pages: **" + transaction.pages.length + "**",
          "Card lines: **" + transaction.plan.rows.length + "**",
          transaction.plan.pendingReview > 0
            ? "Review issues: **" + transaction.plan.pendingReview + "**"
            : "Review issues: **0**",
        ].join("\n"),
        components: [],
      });
    } catch (error) {
      console.error("Failed to attach invoice continuation:", error);
      await interaction.editReply({
        content: "I couldn't attach that continuation page. It remains unassigned; use the dropdown again or re-upload it.",
        components: [buildContinuationMenu(continuationId)],
      });
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    const [prefix, field, transactionId, rowIndexText] = interaction.customId.split(":");
    if (prefix !== "invoice" || field !== "card-number" || !transactionId || rowIndexText === undefined) return;

    const transaction = getPendingTransaction(transactionId);
    if (!transaction) {
      await interaction.reply({ content: "This invoice review has expired or was already handled.", flags: MessageFlags.Ephemeral });
      return;
    }

    const rowIndex = Number(rowIndexText);
    const row = transaction.plan.rows[rowIndex];
    const value = interaction.fields.getTextInputValue("card-number").trim().replace(/^#/, "");
    if (!row || !/^\d+$/.test(value) || Number(value) <= 0) {
      await interaction.reply({ content: "Enter a valid positive card number, such as 006, 088, or 176.", flags: MessageFlags.Ephemeral });
      return;
    }

    row.input.cardNumber = value;
    row.input.reviewFlags = (row.input.reviewFlags ?? []).filter((flag) => flag !== "CARD_NUMBER_UNCERTAIN");
    row.input.reviewRequired = (row.input.reviewFlags ?? []).length > 0;
    row.input.reviewNotes = (row.input.reviewNotes ?? []).filter((note) => !note.includes('temporary value "1" was used'));
    row.input.resolutionReasons = [
      ...(row.input.resolutionReasons ?? []),
      `Card number manually confirmed in Discord review: ${value}.`,
    ];

    // A modal submit must be acknowledged quickly. Persist first, then edit
    // the deferred ephemeral response so Discord does not surface a generic
    // "Something went wrong" interaction failure when storage is successful.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    savePendingTransaction(transaction);

    const remaining = transaction.plan.rows.filter((candidate) => candidate.input.reviewRequired);
    await interaction.editReply({
      content: remaining.length === 0
        ? `✅ **${row.input.cardName || "Card"}** updated to card number **${value}**. All review issues are resolved; the invoice is ready to store.`
        : `✅ **${row.input.cardName || "Card"}** updated to card number **${value}**. ${remaining.length} review issue(s) remain; use **Resolve Review Issues** again.`,
    });

    if (interaction.message) {
      try {
        // Do not rebuild the full review embed here. A large invoice can span
        // multiple Discord messages, and an ephemeral message can only be
        // edited as a single payload. The transaction is already persisted;
        // removing the stale controls is enough. /review re-renders the
        // current transaction when the user wants to continue.
        await interaction.webhook.editMessage(interaction.message.id, {
          components: [reviewActionButtons(transaction)],
        });
      } catch (error) {
        // The transaction is already persisted, so a failed visual refresh
        // must not turn into an unhandled client error or crash the bot.
        console.warn("Could not remove stale review controls:", error);
      }
    }
    return;
  }

  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith("sale:confirm:")) {
    const pendingId = interaction.customId.slice("sale:confirm:".length);
    const pending = pendingSales.get(pendingId);
    if (!pending) {
      await interaction.update({ content: "This sale draft has expired. Run **/sale** again.", components: [] });
      return;
    }

    await interaction.deferUpdate();
    try {
      let allocations: Array<{ allocationId: string; inventoryId: string; qty: number }> = [];
      await withSalePersistenceLock(async () => {
        if (!invoiceTestMode && process.env.GOOGLE_SHEETS_SYNC !== "true") {
          throw new Error("Google Sheets sales persistence is not enabled. Set GOOGLE_SHEETS_SYNC=true before recording sales.");
        }

        // Sale drafts can be prepared concurrently. Generate the final IDs only
        // while holding the persistence lock so two confirmations cannot select
        // the same Sale/Allocation IDs or the same next worksheet row.
        const [saleIds, allocationIds] = invoiceTestMode
          ? [readWorkbookIds(workbookPath!, 4, "SALE"), readWorkbookIds(workbookPath!, 5, "ALLOC")]
          : [await readGoogleSheetSaleIds(), await readGoogleSheetAllocationIds()];
        let maxSale = 0;
        for (const id of saleIds) {
          const match = id.match(/^SALE-(\d+)$/i);
          if (match) maxSale = Math.max(maxSale, Number(match[1]));
        }
        const finalSaleId = saleIds.includes(pending.saleId)
          ? "SALE-" + String(maxSale + 1).padStart(6, "0")
          : pending.saleId;
        let maxAllocation = 0;
        for (const id of allocationIds) {
          const match = id.match(/^ALLOC-(\d+)$/i);
          if (match) maxAllocation = Math.max(maxAllocation, Number(match[1]));
        }
        allocations = pending.allocations.map((allocation, index) => ({
          allocationId: "ALLOC-" + String(maxAllocation + index + 1).padStart(6, "0"),
          inventoryId: allocation.inventoryId,
          qty: allocation.qty,
        }));

        if (invoiceTestMode) {
          persistSaleToWorkbook(workbookPath!, {
            saleId: finalSaleId,
          cardKey: pending.draft.cardKey,
          inventoryId: pending.draft.inventoryId,
          cardName: pending.draft.cardName,
          setSeries: pending.draft.setSeries,
          cardNumber: pending.draft.cardNumber,
          rarity: pending.draft.rarity,
          condition: pending.draft.condition,
          language: pending.draft.language,
          variantPrinting: pending.draft.variantPrinting,
          dateSold: pending.draft.dateSold,
          qtySold: pending.draft.qtySold,
          sellPrice: pending.draft.sellPrice,
            notes: pending.draft.notes,
            allocations,
          });
        } else {
          await writeSaleToGoogleSheets({
            saleId: finalSaleId,
          cardKey: pending.draft.cardKey,
          inventoryId: pending.draft.inventoryId,
          cardName: pending.draft.cardName,
          setSeries: pending.draft.setSeries,
          cardNumber: pending.draft.cardNumber,
          rarity: pending.draft.rarity,
          condition: pending.draft.condition,
          language: pending.draft.language,
          variantPrinting: pending.draft.variantPrinting,
          dateSold: pending.draft.dateSold,
          qtySold: pending.draft.qtySold,
          sellPrice: pending.draft.sellPrice,
            notes: pending.draft.notes,
            allocations,
          });
        }
        pending.saleId = finalSaleId;
        pendingSales.delete(pendingId);
      });

      const remainingAfterSale = pending.selectedRemainingQty - pending.draft.qtySold;
      const soldOut = remainingAfterSale === 0;

      // Remove the consumed lot from any still-live Discord selection cache.
      for (const allocation of allocations) {
        pendingSaleSelections.delete(allocation.inventoryId);
      }

      await interaction.editReply({
        content: [
          "✅ **Sale recorded**",
          "",
          "Sale ID: **" + pending.saleId + "**",
          "Card: **" + pending.draft.cardName + " — " + pending.draft.cardNumber + "**",
          "Quantity: **" + pending.draft.qtySold + "**",
          "Sell price: **₱" + pending.draft.sellPrice.toFixed(2) + " each**",
          "Inventory allocation: **" + allocations.length + " lot(s)**",
          "The Sales Log and Cost Allocation were written together." + (soldOut ? "\n📦 This inventory lot is now **sold out**." : ""),
        ].join("\n"),
        components: [],
      });
    } catch (error) {
      console.error("Failed to record sale:", error);
      await interaction.editReply({
        content: "❌ The sale was not recorded. " + (error instanceof Error ? error.message : "Check the bot logs."),
        components: [],
      });
    }
    return;
  }

  if (interaction.customId.startsWith("sale:cancel:")) {
    const pendingId = interaction.customId.slice("sale:cancel:".length);
    const pending = pendingSales.get(pendingId);
    pendingSales.delete(pendingId);
    await interaction.update({
      content: pending ? "Sale cancelled. No spreadsheet changes were made." : "Sale draft expired. No spreadsheet changes were made.",
      components: [],
    });
    return;
  }

  const [prefix, action, transactionId] = interaction.customId.split(":");
  if (prefix !== "invoice" || !action || !transactionId) return;

  const transaction = getPendingTransaction(transactionId);
  if (!transaction) {
    await interaction.reply({
      content: "This invoice review has expired or was already handled.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "later") {
    await interaction.update({
      content: "Review deferred. This invoice remains pending and has not been stored. Use **/review** to reopen it when you're ready.",
      components: [],
    });
    return;
  }

  if (action === "review") {
    const flagged = transaction.plan.rows.findIndex((row) => row.input.reviewRequired);
    if (flagged < 0) {
      await interaction.reply({ content: "No review issues remain.", flags: MessageFlags.Ephemeral });
      return;
    }

    const row = transaction.plan.rows[flagged];
    const cardNumberFlagged = (row.input.reviewFlags ?? []).includes("CARD_NUMBER_UNCERTAIN");
    if (!cardNumberFlagged) {
      await interaction.reply({
        content: `The remaining issue for **${row.input.cardName || "this card"}** is ${(row.input.reviewFlags ?? []).join(", ")}. Manual card-number correction is currently supported for CARD_NUMBER_UNCERTAIN. Use **/review** to reopen the pending invoice.`,
        flags: MessageFlags.Ephemeral,
      });
      if (interaction.message) {
        try {
          await interaction.webhook.editMessage(interaction.message.id, { components: [] });
        } catch (error) {
          console.warn("Could not remove the review action buttons:", error);
        }
      }
      return;
    }

    await interaction.showModal(buildCardNumberModal(
      transactionId,
      flagged,
      row.input.cardName || "Card",
      row.input.setSeries || "Unknown set",
      row.input.rarity || "Unknown rarity",
      row.input.variantPrinting || "Unknown variant",
      row.input.cardNumber || "1",
    ));
    return;
  }

  if (action === "reject") {
    setTransactionStatus(transaction, "REJECTED");
    await interaction.update({
      content: `❌ **Invoice rejected** — transaction ${transactionId.slice(0, 8)} was not stored.`,
      components: [],
    });
    return;
  }

  if (action === "confirm") {
    if (transaction.plan.insertable === 0) {
      await interaction.reply({
        content: [
          "There are no valid invoice lines to store.",
          `To record: ${transaction.plan.insertable}`,
          `Needs data review: ${transaction.plan.pendingReview}`,
          "The invoice needs to be re-extracted or corrected before it can be recorded.",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      // Acknowledge the button before disk I/O so Discord does not time out the interaction.
      // A stale Discord interaction can return 10062 (Unknown interaction). Treat that
      // as an expired review button instead of allowing the rejection to crash the bot.
      await interaction.deferUpdate();

      // Production workbook backups are currently opt-in. Set
      // INVENTORY_BACKUP_ON_WRITE=true to enable them again.
      if (!invoiceTestMode && process.env.INVENTORY_BACKUP_ON_WRITE === "true") {
        await createInventoryBackup({
          workbookPath,
          inventoryPath,
        });
      }

      // Write the shared Google Sheet before the local workbook. If Sheets is
      // unavailable, the transaction stays pending and the workbook is not
      // partially committed ahead of the shared copy.
      const sheetsStatus = await persistGoogleSheetsIfConfigured(transaction.invoice, transaction.plan);
      const workbookStatus = await persistWorkbookIfConfigured(transaction.invoice, transaction.plan);
      const currentInventoryStore = await createJsonInventoryStore(inventoryPath);
      const applied = await currentInventoryStore.apply(transaction.plan.rows);
      setTransactionStatus(transaction, "STORED");

      await interaction.editReply({
        content: [
          "✅ **Verified inventory stored locally**",
          "",
          `Transaction ${transactionId.slice(0, 8)}`,
          `Inserted: ${applied.inserted}`,
          `Skipped: ${applied.skipped}`,
          `Needs extraction review: ${transaction.plan.pendingReview}`,
          `Rows with review flags: ${transaction.plan.rows.filter((row) => row.input.reviewRequired).length}`,
          "",
          transaction.plan.pendingReview > 0
            ? "All valid purchases were recorded. Rows with missing minimum fields still need extraction correction. Review flags on recorded rows remain attached to those inventory lots."
            : "All invoice rows were recorded. Any review flags remain attached to the corresponding inventory lots for later correction.",
          "",
          `Inventory JSON file: ${inventoryPath}`,
          workbookStatus ?? "Workbook persistence is not enabled; set INVENTORY_WORKBOOK_PATH to enable it.",
          sheetsStatus ?? "Google Sheets persistence is disabled; set GOOGLE_SHEETS_SYNC=true to enable it.",
        ].join("\n"),
        components: [],
      });
    } catch (error) {
      console.error("Failed to store confirmed invoice:", error);
      if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 10062) {
        return;
      }
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: "The verified inventory rows were approved, but local storage failed. The review remains pending. Use **/review** to retry; no review buttons are kept on this message.",
          components: [],
        });
      }
    }
  }
});

client.login(token);
