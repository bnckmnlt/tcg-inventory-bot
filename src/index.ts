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
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { createInventoryBackup } from "./inventory/backup.js";
import { downloadInvoice } from "./invoice.js";
import { extractInvoice } from "./extract.js";
import { enrichCardInput, mergeCatalog } from "./catalog/enrichment.js";
import { TCGdexRuntime } from "./catalog/runtime.js";
import type { Catalog } from "./catalog/types.js";
import { planInvoiceIngestion, type IngestionPlan } from "./inventory/ingest.js";
import { createJsonInventoryStore } from "./inventory/json-store.js";
import { invoicePlanToWorkbookRows, persistInvoicePlanToWorkbookSafely } from "./inventory/workbook-persistence.js";
import { appendInventoryRowsDirectToGoogleSheets } from "./inventory/google-sheets.js";
import {
  createPendingTransaction,
  getPendingTransaction,
  listPendingTransactions,
  removePendingTransaction,
  savePendingTransaction,
} from "./transaction.js";

const token = process.env.DISCORD_TOKEN;
const invoiceChannelId = process.env.INVOICE_CHANNEL_ID;

if (!token) throw new Error("DISCORD_TOKEN is missing from .env");
if (!invoiceChannelId) throw new Error("INVOICE_CHANNEL_ID is missing from .env");

const catalogPath = path.resolve("data/catalog.json");
const invoiceTestMode = process.env.INVOICE_TEST_MODE === "true";
const productionInventoryPath = path.resolve("data/inventory.json");
const productionWorkbookPath = process.env.INVENTORY_WORKBOOK_PATH
  ? path.resolve(process.env.INVENTORY_WORKBOOK_PATH)
  : undefined;
const inventoryPath = invoiceTestMode
  ? path.resolve("/tmp/tcg-inventory-bot-test-inventory.json")
  : productionInventoryPath;
const workbookPath = invoiceTestMode
  ? path.resolve("/tmp/tcg-inventory-bot-test-workbook.xlsx")
  : productionWorkbookPath;

if (invoiceTestMode) {
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
    .setPlaceholder("Select a pending invoice");

  for (const transaction of transactions) {
    const invoice = transaction.invoice;
    const label = (invoice.orderId || invoice.seller || ("Invoice " + transaction.id.slice(0, 8))).slice(0, 100);
    const description = ((invoice.purchaseDate || "Unknown date") + " • " + transaction.plan.rows.length + " line(s) • " + transaction.id.slice(0, 8)).slice(0, 100);
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
    .setTitle(`Resolve: ${cardName} — ${setName}`.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
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

  const result = await appendInventoryRowsDirectToGoogleSheets(rows);
  return `Google Sheets updated: ${result.inserted} inserted, ${result.skipped} already present.`;
}

async function buildPlan(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  sourceMessageId: string,
  catalog: Catalog,
): Promise<{ catalog: Catalog; plan: IngestionPlan }> {
  const store = await createJsonInventoryStore(inventoryPath);
  let workingCatalog = catalog;
  const existingKeys = new Set<string>();
  for (const row of store.list()) {
    existingKeys.add(row.inventoryId);
    const sourceLine = row.sourceLine ?? Number(row.inventoryId.match(/-(\d+)$/)?.[1] ?? NaN);
    if (row.orderId && Number.isInteger(sourceLine) && sourceLine > 0) existingKeys.add(`${row.orderId}:line:${sourceLine}`);
  }
  let plan = planInvoiceIngestion(
    workingCatalog,
    invoice,
    sourceMessageId,
    existingKeys,
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
    { allowMissingCardNumber: true },
  );

  if (enriched) await saveCatalog(workingCatalog);
  return { catalog: workingCatalog, plan };
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log("Logged in as " + readyClient.user.tag);
  console.log("Inventory persistence: " + inventoryPath);

  for (const guild of readyClient.guilds.cache.values()) {
    const commands = await readyClient.application.commands.fetch({ guildId: guild.id });
    const existing = commands.find((command) => command.name === "review");
    const commandData = {
      name: "review",
      description: "Open a pending invoice review",
    };
    if (existing) await existing.edit(commandData);
    else await readyClient.application.commands.create(commandData, guild.id);
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
  if (interaction.isChatInputCommand() && interaction.commandName === "review") {
    const transactions = listPendingTransactions();
    if (transactions.length === 0) {
      await interaction.reply({ content: "There are no pending invoice reviews.", ephemeral: true });
      return;
    }

    const shown = transactions.slice(0, 25);
    await interaction.reply({
      content: shown.length < transactions.length
        ? "Select a pending invoice below. Showing the first " + shown.length + " of " + transactions.length + "."
        : "Select a pending invoice below.",
      components: [buildPendingReviewMenu()],
      ephemeral: true,
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

    await interaction.update({
      content: "Pending invoice " + transaction.id.slice(0, 8),
      embeds: buildReviewEmbeds(transaction.invoice, transaction.plan, transaction.id),
      components: [reviewActionButtons(transaction)],
    });
    return;
  }

  if (interaction.isModalSubmit()) {
    const [prefix, field, transactionId, rowIndexText] = interaction.customId.split(":");
    if (prefix !== "invoice" || field !== "card-number" || !transactionId || rowIndexText === undefined) return;

    const transaction = getPendingTransaction(transactionId);
    if (!transaction) {
      await interaction.reply({ content: "This invoice review has expired or was already handled.", ephemeral: true });
      return;
    }

    const rowIndex = Number(rowIndexText);
    const row = transaction.plan.rows[rowIndex];
    const value = interaction.fields.getTextInputValue("card-number").trim().replace(/^#/, "");
    if (!row || !/^\d+$/.test(value) || Number(value) <= 0) {
      await interaction.reply({ content: "Enter a valid positive card number, such as 006, 088, or 176.", ephemeral: true });
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
    savePendingTransaction(transaction);

    const remaining = transaction.plan.rows.filter((candidate) => candidate.input.reviewRequired);
    await interaction.reply({
      content: remaining.length === 0
        ? `✅ **${row.input.cardName || "Card"}** updated to card number **${value}**. All review issues are resolved; the invoice is ready to store.`
        : `✅ **${row.input.cardName || "Card"}** updated to card number **${value}**. ${remaining.length} review issue(s) remain; use **Resolve Review Issues** again.`,
      ephemeral: true,
    });

    if (interaction.message) {
      try {
        // The /review flow uses an ephemeral message. Edit it through the
        // interaction webhook rather than the channel message manager so the
        // review UI can transition from "Review Now" to "Confirm & Store".
        await interaction.webhook.editMessage(interaction.message.id, {
          embeds: buildReviewEmbeds(transaction.invoice, transaction.plan, transaction.id),
          components: [reviewButtons(
            transaction.id,
            transaction.plan.insertable > 0 && remaining.length === 0,
            remaining.length > 0,
          )],
        });
      } catch (error) {
        // The transaction is already persisted, so a failed visual refresh
        // must not turn into an unhandled client error or crash the bot.
        console.warn("Could not refresh the ephemeral review message:", error);
      }
    }
    return;
  }

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

  if (action === "later") {
    await interaction.reply({
      content: "Review deferred. This invoice remains pending and has not been stored. You can use **Review Now** on this message when you're ready.",
      ephemeral: true,
    });
    return;
  }

  if (action === "review") {
    const flagged = transaction.plan.rows.findIndex((row) => row.input.reviewRequired);
    if (flagged < 0) {
      await interaction.reply({ content: "No review issues remain.", ephemeral: true });
      return;
    }

    const row = transaction.plan.rows[flagged];
    const cardNumberFlagged = (row.input.reviewFlags ?? []).includes("CARD_NUMBER_UNCERTAIN");
    if (!cardNumberFlagged) {
      await interaction.reply({
        content: `The remaining issue for **${row.input.cardName || "this card"}** is ${(row.input.reviewFlags ?? []).join(", ")}. Manual card-number correction is currently supported for CARD_NUMBER_UNCERTAIN.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.showModal(buildCardNumberModal(
      transactionId,
      flagged,
      row.input.cardName || "Card",
      row.input.setSeries || "Unknown set",
      row.input.cardNumber || "1",
    ));
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
      // Create a recoverable local snapshot before any production persistence.
      // Test mode intentionally skips backups because its workbook is disposable.
      if (!invoiceTestMode) {
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
          `Inventory JSON file: ${inventoryPath}`,
          workbookStatus ?? "Workbook persistence is not enabled; set INVENTORY_WORKBOOK_PATH to enable it.",
          sheetsStatus ?? "Google Sheets persistence is disabled; set GOOGLE_SHEETS_SYNC=true to enable it.",
        ].join("\n"),
        components: [],
      });
    } catch (error) {
      console.error("Failed to store confirmed invoice:", error);
      await interaction.editReply({
        content: "The verified inventory rows were approved, but local storage failed. The review remains pending so it can be retried.",
        components: [reviewButtons(
          transactionId,
          transaction.plan.insertable > 0 && !transaction.plan.rows.some((row) => row.input.reviewRequired),
          transaction.plan.rows.some((row) => row.input.reviewRequired),
        )],
      });
    }
  }
});

client.login(token);
