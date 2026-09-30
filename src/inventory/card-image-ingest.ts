import "dotenv/config";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { extractCardImage } from "./card-image.js";
import { planInvoiceIngestion } from "./ingest.js";
import { InMemoryInventoryStore, applyInsertionPlan } from "./local-store.js";
import type { Catalog } from "../catalog/types.js";
import type { InvoiceData } from "../extract.js";

async function loadCatalog(): Promise<Catalog> {
  const catalogPath = path.resolve("data/catalog.json");
  return JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
}

const [, , imagePath, condition = "Near Mint", quantityArg = "1"] = process.argv;

if (!imagePath) {
  console.error("Usage: npm run inventory:image -- <image-path> [condition] [quantity]");
  process.exit(1);
}

const quantity = Number(quantityArg);
if (!Number.isInteger(quantity) || quantity < 1) {
  throw new Error("Quantity must be a positive integer.");
}

const parsed = await extractCardImage(path.resolve(imagePath));
const catalog = await loadCatalog();

const invoice: InvoiceData = {
  seller: null,
  purchaseDate: null,
  orderId: null,
  subtotal: null,
  shipping: null,
  tax: null,
  total: null,
  currency: null,
  uncertainFields: parsed.confidenceNotes,
  lineItems: [{
    productName: parsed.name ?? null,
    setName: parsed.setName ?? null,
    cardNumber: parsed.cardNumber ?? null,
    condition,
    rarity: null,
    language: parsed.language ?? null,
    variant: parsed.variant ?? null,
    quantity,
    unitPrice: null,
    totalPrice: null,
  }],
};

const sourceMessageId = "LOCAL-" + Date.now();
const store = new InMemoryInventoryStore();
const plan = planInvoiceIngestion(
  catalog,
  invoice,
  sourceMessageId,
  new Set(store.list().map((row) => row.inventoryId)),
);
const applied = applyInsertionPlan(store, plan.rows);

console.log(JSON.stringify({
  imagePath: path.resolve(imagePath),
  parsed,
  plan,
  applied,
  localInventory: store.list(),
}, null, 2));
