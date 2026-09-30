export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ");
}

export function normalizeSetName(value: string | undefined): string {
  const normalized = normalizeText(value)
    .replace(/^(?:sv\d{2}(?:\.\d+)?|sv|sve|swsh\d{2}|swsh|sm\d{2}|sm|xy\d{2}|xy|me\d{2}|me)\s*[:\-]\s*/, "");
  const aliases: Record<string, string> = {
    "scarlet violet promo": "svp black star promos",
    "mega evolution promo": "mep black star promos",
    "scarlet & violet energies": "scarlet & violet energy",
    "sve scarlet & violet energies": "scarlet & violet energy",
    "sword and shield base set": "sword & shield",
    "trading card game classic": "tcg classic",
    "ex power keepers": "power keepers",
  };
  return aliases[normalized] ?? normalized;
}

export function normalizeCardNumber(value: string | undefined): string {
  return normalizeText(value)
    .replace(/^#/, "")
    .replace(/\s+/g, "")
    .replace(/^(\d+)\s*\/\s*(\d+)$/, function (_match, numerator, denominator) {
      return String(Number(numerator)) + "/" + String(Number(denominator));
    })
    .replace(/^\d+$/, (digits) => String(Number(digits)));
}

export function normalizeLanguage(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (["en", "eng", "english"].includes(normalized)) return "English";
  if (["ja", "jpn", "japanese"].includes(normalized)) return "Japanese";
  return value?.trim() ?? "";
}

export function normalizeVariant(value: string | null | undefined): string {
  const normalized = normalizeText(value ?? undefined);
  if (!normalized || normalized === "normal") return "Normal";
  const aliases: Record<string, string> = {
    holofoil: "holo",
    foil: "holo",
    "reverse holo": "reverse",
    "reverse holofoil": "reverse",
    "reverse foil": "reverse",
    "cracked ice holo": "Normal",
  };
  return aliases[normalized] ?? normalized;
}

/**
 * Return the exact printing labels expected by the inventory/workbook surface.
 * Internal catalog data may use compact labels such as "holo" and "reverse".
 */
export function normalizeInventoryVariant(value: string | null | undefined): string {
  const semantic = normalizeVariant(value);
  if (semantic === "holo") return "Holofoil";
  if (semantic === "reverse") return "Reverse Holofoil";
  return value?.trim() || "Normal";
}

/**
 * V2 inventory sometimes embeds a physical printing/pattern description in
 * the card name. These suffixes are not part of the catalog card identity;
 * the actual variant is represented separately by `variant`.
 */
export function normalizeInventoryCardName(value: string | undefined): string {
  const normalized = normalizeText(value);
  return normalized
    .replace(/\s*\((?:full art|cosmos holo|cracked ice holo|pokeball(?: patt(?:ern)?\.?)?|masterball(?: patt(?:ern)?)?|energy symbol patt(?:ern)?\.?|clb|clc|clv)\)\s*$/i, "")
    .replace(/\s+-\s+\d+\s*\/\s*\d+\s*$/i, "")
    .trim();
}
