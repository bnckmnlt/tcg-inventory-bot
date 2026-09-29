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

function buildReviewEmbeds(
  invoice: Awaited<ReturnType<typeof extractInvoice>>,
  transactionId: string,
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  const transactionLabel = transactionId.slice(0, 8);

  const summary = new EmbedBuilder()
    .setTitle("🔎 Invoice Review")
    .setDescription("Check the extracted purchase data against the invoice before confirming.")
    .addFields(
      { name: "Seller", value: invoice.seller ?? "Unknown", inline: true },
      { name: "Purchase Date", value: invoice.purchaseDate ?? "Unknown", inline: true },
      { name: "Order ID", value: invoice.orderId ?? "Unknown", inline: true },
      { name: "Subtotal", value: formatMoney(invoice.subtotal, invoice.currency), inline: true },
      { name: "Shipping", value: formatMoney(invoice.shipping, invoice.currency), inline: true },
      { name: "Tax", value: formatMoney(invoice.tax, invoice.currency), inline: true },
      { name: "Total", value: formatMoney(invoice.total, invoice.currency), inline: true },
    )
    .setFooter({ text: `Transaction ${transactionLabel} • Pending confirmation` });

  if (invoice.uncertainFields.length > 0) {
    summary.addFields({
      name: "⚠️ Needs Review",
      value: invoice.uncertainFields.join(", ").slice(0, 1024),
    });
  }

  embeds.push(summary);

  if (invoice.lineItems.length === 0) {
    embeds.push(
      new EmbedBuilder()
        .setTitle("Cards")
        .setDescription("No line items were found in the invoice.")
        .setFooter({ text: `Transaction ${transactionLabel}` }),
    );
    return embeds;
  }

  for (let start = 0; start < invoice.lineItems.length; start += 4) {
    const cardEmbed = new EmbedBuilder()
      .setTitle(start === 0 ? "Cards" : "Cards — continued")
      .setFooter({ text: `Transaction ${transactionLabel} • ${invoice.lineItems.length} line items` });

    invoice.lineItems.slice(start, start + 4).forEach((item, offset) => {
      const index = start + offset + 1;
      const details = [
        `Set: ${item.setName ?? "Unknown"}`,
        `Card No.: ${item.cardNumber ?? "Unknown"}`,
        `Rarity: ${item.rarity ?? "Unknown"}`,
        `Condition: ${item.condition ?? "Unknown"}`,
        `Language: ${item.language ?? "Unknown"}`,
        `Variant: ${item.variant ?? "Unknown"}`,
      ].join("\n");

      const pricing = [
        `Qty: ${item.quantity ?? "?"}`,
        `Unit: ${formatMoney(item.unitPrice, invoice.currency)}`,
        `Total: ${formatMoney(item.totalPrice, invoice.currency)}`,
      ].join(" • ");

      cardEmbed.addFields({
        name: `${index}. ${item.productName ?? "Unknown card"}`,
        value: `${details}\n${pricing}`,
      });
    });

    embeds.push(cardEmbed);
  }

  return embeds;
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
      ].join("\n"));

      const invoice = await extractInvoice(filePath);
      const transaction = createPendingTransaction(invoice, message.id, [attachment.name ?? "invoice"]);

      const reviewEmbeds = buildReviewEmbeds(invoice, transaction.id);

      for (let index = 0; index < reviewEmbeds.length; index += 10) {
        const embedChunk = reviewEmbeds.slice(index, index + 10);
        const isLastChunk = index + 10 >= reviewEmbeds.length;
        await message.reply({
          embeds: embedChunk,
          components: isLastChunk ? [reviewButtons(transaction.id)] : [],
        });
      }

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
      ].join("\n"),
      components: [],
    });
  }
});

client.login(token);
