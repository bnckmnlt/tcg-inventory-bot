import { readFile, writeFile } from "node:fs/promises";
import type { Catalog } from "./types.js";

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const inputArg = process.argv.find((arg) => arg.startsWith("--inputs="));
if (!outputArg || !inputArg) {
  console.error("Usage: npm run catalog:merge -- --inputs=a.json,b.json [--output=data/catalog.json]");
  process.exit(1);
}

const output = outputArg.slice("--output=".length);
const inputs = inputArg.slice("--inputs=".length).split(",").map((value) => value.trim()).filter(Boolean);
const catalogs = await Promise.all(inputs.map(async (path) => JSON.parse(await readFile(path, "utf8")) as Catalog));

const mergeById = <T>(items: T[], getId: (item: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
};

const merged: Catalog = {
  sets: mergeById(catalogs.flatMap((catalog) => catalog.sets), (item) => item.setId),
  cards: mergeById(catalogs.flatMap((catalog) => catalog.cards), (item) => item.catalogCardId),
  printings: mergeById(catalogs.flatMap((catalog) => catalog.printings), (item) => item.printingId),
  variants: mergeById(catalogs.flatMap((catalog) => catalog.variants), (item) => item.variantId),
  skus: mergeById(catalogs.flatMap((catalog) => catalog.skus), (item) => item.skuId),
  externalIdMappings: mergeById(catalogs.flatMap((catalog) => catalog.externalIdMappings), (item) => item.externalIdMapId),
};

await writeFile(output, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  output,
  inputs,
  sets: merged.sets.length,
  cards: merged.cards.length,
  printings: merged.printings.length,
  variants: merged.variants.length,
  skus: merged.skus.length,
  externalIdMappings: merged.externalIdMappings.length,
}, null, 2));
