import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Attachment } from "discord.js";

const invoiceDirectory = path.resolve("data/invoices");

export async function downloadInvoice(
  attachment: Attachment,
): Promise<string> {
  await mkdir(invoiceDirectory, { recursive: true });

  const extension = path.extname(attachment.name ?? "").toLowerCase() || ".jpg";
  const safeName = (attachment.name ?? "invoice")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".");
  const baseName = path.basename(safeName, path.extname(safeName)) || "invoice";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${timestamp}-${baseName}${extension}`;
  const filePath = path.join(invoiceDirectory, fileName);

  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(
      `Failed to download invoice: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);

  return filePath;
}
