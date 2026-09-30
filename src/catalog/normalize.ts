export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ");
}

export function normalizeCardNumber(value: string | undefined): string {
  return normalizeText(value)
    .replace(/^#/, "")
    .replace(/\s+/g, "")
    .replace(/^(\d+)\s*\/\s*(\d+)$/, function (_match, numerator, denominator) {
      return String(Number(numerator)) + "/" + String(Number(denominator));
    });
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
  return normalized;
}
