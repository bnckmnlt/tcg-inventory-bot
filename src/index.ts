import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Message,
} from "discord.js";
import { downloadInvoice } from "./invoice.js";
import { extractInvoice } from "./extract.js";
import {
  createPendingTransaction,
  getPendingTransaction,
  removePendingTransaction,
} from "./transaction.js";

const token = process.env.DISCORD_TOKEN;
const invoiceChannelId = process.env.INVOICE_CHANNEL_ID;

if (!token) throw new Error("DISCORD_TOKEN is missing from .env");
if (!invoiceChannelId) throw new Error("INVOICE_CHANNEL_ID is missing from .env");

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

function buildReviewMessage(invoice: Awaited<ReturnType<typeof extractInvoice>>, transactionId: string): string {
  const itemLines = invoice.lineItems.flatMap((item, index) => {
    const details = [
      `Set: ${item.setName ?? "Unknown"}`,
      `No.: ${item.cardNumber ?? "Unknown"}`,
      `Rarity: ${item.rarity ?? "Unknown"}`,
      `Condition: ${item.condition ?? "Unknown"}`,
      `Language: ${item.language ?? "Unknown"}`,
      `Variant: ${item.variant ?? "Unknown"}`,
    ];

    const pricing = [
      `Qty: ${item.quantity ?? "?"}`,
      `Unit: ${formatMoney(item.unitPrice, invoice.currency)}`,
      `Total: ${formatMoney(item.totalPrice, invoice.currency)}`,
    ];

    return [
      `**${index + 1}. ${item.productName ?? "Unknown card"}**`,
      details.join(" • "),
      pricing.join(" • "),
    ];
  });

  const uncertainty = invoice.uncertainFields.length > 0
    ? ["", `⚠️ **Needs review:** ${invoice.uncertainFields.join(", ")}`]
    : [];

  return [
    "🔎 **Review invoice before saving**",
    "",
    `**Transaction ID:** ${transactionId.slice(0, 8)}`,
    `**Seller:** ${invoice.seller ?? "Unknown"}`,
    `**Purchase date:** ${invoice.purchaseDate ?? "Unknown"}`,
    `**Order ID:** ${invoice.orderId ?? "Unknown"}`,
    `**Subtotal:** ${formatMoney(invoice.subtotal, invoice.currency)}`,
    `**Shipping:** ${formatMoney(invoice.shipping, invoice.currency)}`,
    `**Tax:** ${formatMoney(invoice.tax, invoice.currency)}`,
    `**Total:** ${formatMoney(invoice.total, invoice.currency)}`,
    "",
    "**Cards:**",
    ...(itemLines.length > 0 ? itemLines : ["No line items found."]),
    ...uncertainty,
    "",
    "Confirm only after checking the extracted fields against the invoice.",
  ].join("\\n");
}

function reviewButtons(transactionId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`invoice:confirm:${transactionId}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`invoice:reject:${transactionId}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
  );
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
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

      await message.reply([
        "📥 Invoice received and saved.",
        "",
        "🔎 Extracting purchase data...",
        `**File:** ${attachment.name}`,
      ].join("\\n"));

      const invoice = await extractInvoice(filePath);
      const transaction = createPendingTransaction(invoice, message.id, [attachment.name ?? "invoice"]);

      await message.reply({
        content: buildReviewMessage(invoice, transaction.id),
        components: [reviewButtons(transaction.id)],
      });

      console.log("Invoice extracted and awaiting confirmation:", transaction.id);
    } catch (error) {
      console.error("Failed to process invoice:", error);
      await message.reply("I received the image, but I couldn't process it. Check the bot logs for details.");
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
      content: `❌ **Invoice rejected** — transaction ${transactionId.slice(0, 8)} was not saved.`,
      components: [],
    });
    return;
  }

  if (action === "confirm") {
    removePendingTransaction(transactionId);
    await interaction.update({
      content: [
        "✅ **Invoice confirmed**",
        "",
        `Transaction ${transactionId.slice(0, 8)} is approved and ready for the Google Sheets integration.`,
        "",
        "Nothing has been written to Google Sheets yet.",
      ].join("\\n"),
      components: [],
    });
  }
});

client.login(token);
