import "dotenv/config";
import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import { downloadInvoice } from "./invoice.js";

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
          "📥 Invoice received and saved!",
          "",
          `**File:** ${attachment.name}`,
          `**Saved:** ${filePath}`,
          `**Size:** ${attachment.size.toLocaleString()} bytes`,
        ].join("\n"),
      );

      console.log("Invoice saved:", filePath);
    } catch (error) {
      console.error("Failed to save invoice:", error);

      await message.reply(
        "I received the image, but I couldn't save it. Check the bot logs for details.",
      );
    }
  }
});

client.login(token);
