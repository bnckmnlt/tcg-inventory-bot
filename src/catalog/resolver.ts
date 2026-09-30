import type { Catalog, CardInput, ResolveResult, Printing, Variant, Card, Sku } from "./types.js";
import { normalizeCardNumber, normalizeLanguage, normalizeText, normalizeVariant } from "./normalize.js";

function variantsFor(catalog: Catalog, printingId: string): Variant[] {
  return catalog.variants.filter((variant) => variant.printingId === printingId);
}

function candidateRows(catalog: Catalog, printings: Printing[]) {
  return printings.map((printing) => ({
    printing,
    card: catalog.cards.find((card) => card.catalogCardId === printing.catalogCardId)!,
    variants: variantsFor(catalog, printing.printingId),
  }));
}

export function resolveCardInput(catalog: Catalog, input: CardInput): ResolveResult {
  const reasons: string[] = [];
  const name = normalizeText(input.name);
  const setName = normalizeText(input.setName);
  const setCode = normalizeText(input.setCode);
  const number = normalizeCardNumber(input.cardNumber);
  const language = normalizeLanguage(input.language);
  const variant = normalizeVariant(input.variant);

  if (!setName && !setCode) reasons.push("Set is required.");
  if (!number) reasons.push("Card number is required.");
  if (!name && !number) reasons.push("Name or card number is required.");

  let printings = catalog.printings.filter((printing) => {
    if (setName && normalizeText(printing.setName) !== setName) return false;
    if (setCode && normalizeText(printing.setCode) !== setCode) return false;
    if (number && normalizeCardNumber(printing.cardNumber) !== number) return false;
    if (language && normalizeLanguage(printing.language) !== language) return false;
    return true;
  });

  if (printings.length === 0) {
    return { state: reasons.length ? "INCOMPLETE" : "UNMATCHED", candidates: [], reasons: [...reasons, "No printing matched the supplied set/number/language."] };
  }

  if (name) {
    const named = printings.filter((printing) => {
      const card = catalog.cards.find((candidate) => candidate.catalogCardId === printing.catalogCardId);
      return card && normalizeText(card.canonicalName) === name;
    });
    if (named.length > 0) printings = named;
    else return { state: "CONFLICT", candidates: candidateRows(catalog, printings), reasons: [...reasons, "Name conflicts with the catalog printing identified by set/number."] };
  }

  const candidates = candidateRows(catalog, printings);
  if (candidates.length !== 1) {
    return { state: "AMBIGUOUS", candidates, reasons: [...reasons, "More than one printing matches the supplied identity fields."] };
  }

  const row = candidates[0];
  const matchingVariants = row.variants.filter((candidate) => normalizeVariant(candidate.variantLabel) === variant || normalizeVariant(candidate.variantType) === variant);
  if (matchingVariants.length === 0) {
    return { state: "AMBIGUOUS", ...row, candidates, reasons: [...reasons, `Variant "${input.variant ?? "Normal"}" is not available for this printing.`] };
  }
  if (matchingVariants.length > 1) {
    return { state: "AMBIGUOUS", ...row, candidates, reasons: [...reasons, "Variant matches multiple catalog records."] };
  }

  const selectedVariant = matchingVariants[0];
  if (!input.condition) {
    return { state: "INCOMPLETE", ...row, variant: selectedVariant, candidates, reasons: [...reasons, "Condition is required to resolve a SKU."] };
  }

  const skus = catalog.skus.filter((sku) => sku.variantId === selectedVariant.variantId && normalizeText(sku.condition) === normalizeText(input.condition) && normalizeLanguage(sku.language) === language);
  if (skus.length !== 1) {
    return { state: skus.length > 1 ? "AMBIGUOUS" : "UNMATCHED", ...row, variant: selectedVariant, candidates, reasons: [...reasons, skus.length ? "Multiple SKUs match the supplied condition." : "No SKU matches the supplied condition/language."] };
  }

  const sku: Sku = skus[0];
  return { state: "EXACT", ...row, variant: selectedVariant, sku, candidates, reasons };
}
