import { mkdir, writeFile } from "node:fs/promises";
import { importTCGdex } from "./tcgdex.js";

const setArg = process.argv.find((arg) => arg.startsWith("--sets="));
const languageArg = process.argv.find((arg) => arg.startsWith("--language="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));

if (!setArg) {
  console.error("Usage: npm run catalog:import -- --sets=sv03.5,svp [--language=en] [--output=data/catalog.json]");
  process.exit(1);
}

const setIds = setArg.slice("--sets=".length).split(",").map((value) => value.trim()).filter(Boolean);
const language = languageArg?.slice("--language=".length) ?? "en";
const output = outputArg?.slice("--output=".length) ?? "data/catalog.json";

const catalog = await importTCGdex({ setIds, language });

await mkdir(output.substring(0, output.lastIndexOf("/")) || ".", { recursive: true });
await writeFile(output, JSON.stringify(catalog, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  output,
  sets: setIds,
  language,
  cards: catalog.cards.length,
  printings: catalog.printings.length,
  variants: catalog.variants.length,
  skus: catalog.skus.length,
}, null, 2));
