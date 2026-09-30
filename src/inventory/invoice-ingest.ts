import "dotenv/config";
import path from "node:path";
import { extractInvoice } from "../extract.js";
import { enrichCardInput, mergeCatalog } from "../catalog/enrichment.js";
import { TCGdexRuntime } from "../catalog/runtime.js";
import { planInvoiceIngestion } from "./ingest.js";
import { InMemoryInventoryStore, applyInsertionPlan } from "./local-store.js";
import type { Catalog } from "../catalog/types.js";
import { readFile, writeFile } from "node:fs/promises";

const catalogPath = path.resolve("data/catalog.json");

async function loadCatalog(): Promise<Catalog> {
  return JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
}

const [, , imagePath] = process.argv;

if (!imagePath) {
  console.error("Usage: npm run inventory:invoice -- <invoice-image-path>");
  process.exit(1);
}

const resolvedPath = path.resolve(imagePath);
const invoice = await extractInvoice(resolvedPath);
const catalog = await loadCatalog();

const sourceMessageId = "LOCAL-INVOICE-" + Date.now();
const store = new InMemoryInventoryStore();

let workingCatalog = catalog;
const runtime = new TCGdexRuntime();
const enrichment: Array<{
  sourceLine: number;
  state: string;
  cardName: string;
  setName: string;
  candidates: number;
  reason?: string;
}> = [];

let plan = planInvoiceIngestion(
  workingCatalog,
  invoice,
  sourceMessageId,
  new Set(store.list().map((row) => row.inventoryId)),
  { allowMissingCardNumber: true },
);

for (const row of plan.rows.filter((candidate) => candidate.action === "INSERT" && candidate.state === "UNMATCHED")) {
  const result = await enrichCardInput(workingCatalog, {
    name: row.input.cardName,
    setName: row.input.setSeries,
    cardNumber: row.input.cardNumber,
    language: row.input.language,
    variant: row.input.variantPrinting,
    condition: row.input.condition,
  }, runtime);

  enrichment.push({
    sourceLine: row.sourceLine,
    state: result.state,
    cardName: row.input.cardName,
    setName: row.input.setSeries,
    candidates: result.externalCandidates.length,
    reason: result.reason,
  });

  if (result.state === "ENRICHED" && result.catalog) {
    workingCatalog = mergeCatalog(workingCatalog, result.catalog);
  }
}

// Re-plan against the accumulated local catalog. This is what makes a verified
// discovery useful on the next invoice without importing an entire set.
plan = planInvoiceIngestion(
  workingCatalog,
  invoice,
  sourceMessageId,
  new Set(store.list().map((row) => row.inventoryId)),
  { allowMissingCardNumber: true },
);

if (enrichment.some((entry) => entry.state === "ENRICHED")) {
  await writeFile(catalogPath, JSON.stringify(workingCatalog, null, 2) + "\n", "utf8");
}

const applied = applyInsertionPlan(store, plan.rows);

console.log(JSON.stringify({
  imagePath: resolvedPath,
  invoice,
  enrichment,
  plan,
  applied,
  localInventory: store.list(),
}, null, 2));
