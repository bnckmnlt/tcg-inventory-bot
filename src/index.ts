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
} from "discord.js";
import path from "node:path";
import { downloadInvoice } from "./invoice.js";
import { extractInvoice } from "./extract.js";
import { enrichCardInput, mergeCatalog } from "./catalog/enrichment.js";
import { TCGdexRuntime } from "./catalog/runtime.js";
import type { Catalog } from "./catalog/types.js";
import { planInvoiceIngestion, type IngestionPlan } from "./inventory/ingest.js";
import { createJsonInventoryStore } from "./inventory/json-store.js";
import {
  createPendingTransaction,
  getPendingTransaction,
  removePendingTransaction,
} from "./transaction.js";

const token = process.env.DISCORD_TOKEN;
const invoiceChannelId = process.env.INVOICE_CHANNEL_ID;

if (!token) throw new Error("DISCORD_TOKEN is missing from .env");
if (!invoiceChannelId) throw new Error("INVOICE_CHANNEL_ID is missing from .env");

const catalogPath = path.resolve("data/catalog.json");
const inventoryPath = path.resolve("data/inventory.json");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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
        name: `${index}. ${row.input.cardName || "Unknown card"} — ${row.action}`,
        value: `${details}${row.input.reviewNotes?.length ? `\nNotes: ${row.input.reviewNotes.join(" ").slice(0, 500)}` : ""}\n\nReason: ${row.reasons.join(" ").slice(0, 700)}`,
        inline: false,
      });
    });

    embeds.push(cardEmbed);
  }

  return embeds;
}

function reviewButtons(transactionId: string, canConfirm: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`invoice:confirm:${transactionId}`)
      .setLabel(canConfirm ? "Confirm & Store" : "Confirm & Store (blocked)")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canConfirm),
    new ButtonBuilder()
      .setCustomId(`invoice:reject:${transactionId}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );
}

async function loadCatalog(): Promise<Catalog> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
}

async function saveCatalog(catalog: Catalog): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

async function buildPlan(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  sourceMessageId: string,
  catalog: Catalog,
): Promise<{ catalog: Catalog; plan: IngestionPlan }> {
  const store = await createJsonInventoryStore(inventoryPath);
  let workingCatalog = catalog;
  let plan = planInvoiceIngestion(
    workingCatalog,
    invoice,
    sourceMessageId,
    new Set(store.list().map((row) => row.inventoryId)),
    { allowMissingCardNumber: true },
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

    if (result.state === "ENRICHED" && result.catalog) {
      workingCatalog = mergeCatalog(workingCatalog, result.catalog);
      enriched = true;
    }
  }

  plan = planInvoiceIngestion(
    workingCatalog,
    invoice,
    sourceMessageId,
    new Set(store.list().map((row) => row.inventoryId)),
    { allowMissingCardNumber: true },
  );

  if (enriched) await saveCatalog(workingCatalog);
  return { catalog: workingCatalog, plan };
}

const inventoryStore = await createJsonInventoryStore(inventoryPath);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Inventory persistence: ${inventoryPath}`);
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

      // Reload from disk for every invoice so duplicate detection always sees
      // the latest persisted inventory, even if the bot has been running for
      // a long time or another process wrote the inventory file.
      const currentInventoryStore = await createJsonInventoryStore(inventoryPath);

      // Order ID is the stable invoice-level idempotency key. Do not require
      // seller equality: the order ID itself identifies the invoice, and seller
      // extraction can vary slightly between OCR/model passes.
      if (invoice.orderId) {
        const existing = currentInventoryStore.list().filter(
          (row) => row.orderId === invoice.orderId,
        );

        if (existing.length > 0) {
          await message.reply({
            content: [
              "ℹ️ **Invoice already stored**",
              "",
              `Order ID: ${invoice.orderId}`,
              `Seller: ${invoice.seller ?? existing[0].seller ?? "Unknown"}`,
              `Existing inventory records: ${existing.length}`,
              "",
              "Nothing was added to inventory.",
            ].join("\n"),
          });
          continue;
        }
      }

      const catalog = await loadCatalog();
      const sourceMessageId = `DISCORD-${message.id}-${attachment.id}`;
      const resolved = await buildPlan(invoice, sourceMessageId, catalog);

      const transaction = createPendingTransaction(
        invoice,
        sourceMessageId,
        [attachment.name ?? "invoice"],
        resolved.catalog,
        resolved.plan,
      );

      const reviewEmbeds = buildReviewEmbeds(invoice, resolved.plan, transaction.id);

      for (let index = 0; index < reviewEmbeds.length; index += 10) {
        const embedChunk = reviewEmbeds.slice(index, index + 10);
        const isLastChunk = index + 10 >= reviewEmbeds.length;
        await message.reply({
          embeds: embedChunk,
          components: isLastChunk
            ? [reviewButtons(transaction.id, resolved.plan.insertable > 0)]
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
  if (!interaction.isButton()) return;

  const [prefix, action, transactionId] = interaction.customId.split(":");
  if (prefix !== "invoice" || !action || !transactionId) return;

  const transaction = getPendingTransaction(transactionId);
  if (!transaction) {
    await interaction.reply({
      content: "This invoice review has expired or was already handled.",
      ephemeral: true,
    });
    return;
  }

  if (action === "reject") {
    removePendingTransaction(transactionId);
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
        ephemeral: true,
      });
      return;
    }

    // Acknowledge the button before disk I/O so Discord does not time out the interaction.
    await interaction.deferUpdate();

    try {
      const insertableRows = transaction.plan.rows.filter((row) => row.action === "INSERT");
      const currentInventoryStore = await createJsonInventoryStore(inventoryPath);
      const applied = await currentInventoryStore.apply(insertableRows);
      removePendingTransaction(transactionId);

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
          `Inventory file: ${inventoryPath}`,
          "Google Sheets persistence is intentionally not connected yet.",
        ].join("\n"),
        components: [],
      });
    } catch (error) {
      console.error("Failed to store confirmed invoice:", error);
      await interaction.editReply({
        content: "The verified inventory rows were approved, but local storage failed. The review remains pending so it can be retried.",
        components: [reviewButtons(transactionId, true)],
      });
    }
  }
});

client.login(token);
