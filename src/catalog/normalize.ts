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
    .replace(/^(?:sv\d{2}(?:\.\d+)?|sv|sve|swsh\d{2}|me\d{2}|me):\s*/, "");
  const aliases: Record<string, string> = {
    "scarlet violet promo": "svp black star promos",
    "mega evolution promo": "mep black star promos",
    "scarlet & violet energies": "scarlet & violet energy",
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

export function normalizeVariant(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized === "normal") return "Normal";
  const aliases: Record<string, string> = {
    holofoil: "holo",
    "reverse holofoil": "reverse",
  };
  return aliases[normalized] ?? normalized;
}
