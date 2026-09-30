import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { V2WorkbookParseResult } from "./v2-workbook.js";
import { parseV2InventorySheet } from "./v2-workbook.js";

function unzipEntry(path: string, entry: string): string {
  return execFileSync("unzip", ["-p", path, entry], { encoding: "utf8" });
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "")) : "";
}

function columnNumber(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "";
  let number = 0;
  for (const letter of letters) number = number * 26 + letter.charCodeAt(0) - 64;
  return number;
}

function sharedStrings(path: string): string[] {
  let xml = "";
  try {
    xml = unzipEntry(path, "xl/sharedStrings.xml");
  } catch {
    return [];
  }
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => {
    const parts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)];
    return parts.map((part) => decodeXml(part[1])).join("");
  });
}

function sheetEntries(path: string): Array<{ name: string; target: string }> {
  const workbook = unzipEntry(path, "xl/workbook.xml");
  const rels = unzipEntry(path, "xl/_rels/workbook.xml.rels");
  const relationshipMap = new Map<string, string>();

  for (const match of rels.matchAll(/<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"/g)) {
    const target = match[2].replace(/^\//, "");
    relationshipMap.set(match[1], target.startsWith("xl/") ? target : `xl/${target}`);
  }

  const sheets: Array<{ name: string; target: string }> = [];
  for (const match of workbook.matchAll(/<sheet\s+([^>]+?)\s*\/>/g)) {
    const attrs = match[1];
    const name = attrs.match(/name="([^"]+)"/)?.[1];
    const rid = attrs.match(/r:id="([^"]+)"/)?.[1];
    const target = rid ? relationshipMap.get(rid) : undefined;
    if (name && target) sheets.push({ name: decodeXml(name), target });
  }
  return sheets;
}

function worksheetRows(path: string, target: string, strings: string[]): unknown[][] {
  const xml = unzipEntry(path, target);
  const rows: unknown[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values: unknown[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = attrs.match(/r="([A-Z]+\d+)"/i)?.[1] ?? "";
      const index = Math.max(0, columnNumber(ref) - 1);
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const formula = body.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1] ?? "";
      const rawValue = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const inlineValue = type === "inlineStr"
        ? body.match(/<is[^>]*>([\s\S]*?)<\/is>/)?.[1]?.replace(/<[^>]+>/g, "") ?? ""
        : "";
      let value: unknown = inlineValue || rawValue;

      if (type === "s") {
        const stringIndex = Number(rawValue);
        value = Number.isInteger(stringIndex) ? strings[stringIndex] ?? "" : "";
      } else if (type !== "str" && type !== "inlineStr" && rawValue !== "") {
        const numeric = Number(rawValue);
        value = Number.isFinite(numeric) ? numeric : rawValue;
      }

      if (formula && rawValue === "") value = "";
      values[index] = value;
    }
    rows.push(values);
  }

  return rows;
}

export function readV2InventoryWorkbook(path: string): V2WorkbookParseResult {
  if (!existsSync(path)) throw new Error(`Workbook not found: ${path}`);

  const inventory = sheetEntries(path).find((sheet) => sheet.name.toLowerCase() === "inventory");
  if (!inventory) {
    return { rows: [], issues: [{ sourceRow: 1, message: 'Workbook has no "Inventory" sheet.' }] };
  }

  return parseV2InventorySheet(worksheetRows(path, inventory.target, sharedStrings(path)));
}
