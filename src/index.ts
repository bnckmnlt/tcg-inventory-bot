import "dotenv/config";
import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import { downloadInvoice } from "./invoice.js";
import { extractInvoice } from "./extract.js";

const token = process.env.DISCORD_TOKEN;
const invoiceChannelId = process.env.INVOICE_CHANNEL_ID;

if (!token) {
  throw new Error("DISCORD_TOKEN is missing from .env");
}

if (!invoiceChannelId) {
  throw new Error("INVOICE_CHANNEL_ID is missing from .env");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (message.channelId !== invoiceChannelId) return;
  if (message.attachments.size === 0) return;

  const imageAttachments = [...message.attachments.values()].filter(
    (attachment) => attachment.contentType?.startsWith("image/"),
  );

  if (imageAttachments.length === 0) {
    await message.reply("I found no image attachments in that message.");
    return;
  }

  for (const attachment of imageAttachments) {
    console.log("Image received:", {
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    });

    try {
      const filePath = await downloadInvoice(attachment);

      await message.reply(
        [
          "📥 Invoice received and saved.",
          "",
          "🔎 Extracting purchase data...",
          `**File:** ${attachment.name}`,
        ].join("\n"),
      );

      const invoice = await extractInvoice(filePath);

      const itemLines = invoice.lineItems.map((item, index) => {
        const quantity = item.quantity ?? "?";
        const price =
          item.unitPrice !== null ? `$${item.unitPrice.toFixed(2)} each` : "price unknown";

        return `${index + 1}. ${item.productName ?? "Unknown card"} — ${quantity} × ${price}`;
      });

      const uncertainty =
        invoice.uncertainFields.length > 0
          ? `\n⚠️ **Needs review:** ${invoice.uncertainFields.join(", ")}`
          : "";

      await message.reply(
        [
          "✅ **Invoice extracted**",
          "",
          `**Seller:** ${invoice.seller ?? "Unknown"}`,
          `**Purchase date:** ${invoice.purchaseDate ?? "Unknown"}`,
          `**Order ID:** ${invoice.orderId ?? "Unknown"}`,
          `**Total:** ${invoice.total !== null ? `${invoice.currency ?? ""} ${invoice.total.toFixed(2)}`.trim() : "Unknown"}`,
          "",
          "**Cards:**",
          ...(itemLines.length > 0 ? itemLines : ["No line items found."]),
          uncertainty,
        ].filter(Boolean).join("\n"),
      );

      console.log("Invoice extracted:", invoice);
    } catch (error) {
      console.error("Failed to process invoice:", error);

      await message.reply(
        "I received the image, but I couldn't process it. Check the bot logs for details.",
      );
    }
  }
});

client.login(token);
