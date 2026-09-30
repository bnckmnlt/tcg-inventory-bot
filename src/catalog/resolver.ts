import type { Catalog, CardInput, ResolveResult, Printing, Variant, Card, Sku } from "./types.js";
import { normalizeCardNumber, normalizeInventoryCardName, normalizeLanguage, normalizeSetName, normalizeText, normalizeVariant } from "./normalize.js";

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

/**
 * Stable identity mappings for workbook printings that are known but are not
 * represented in the local catalog as normal TCGdex printings. These are
 * deliberately identity-only: they must not manufacture a TCGPlayer SKU.
 */
function knownIdentityOverride(input: CardInput): { printing: Printing; card: Card; variant: Variant; reason: string } | undefined {
  const setName = normalizeSetName(input.setName);
  const rawName = normalizeText(input.name);
  const number = normalizeCardNumber(input.cardNumber);
  const language = normalizeLanguage(input.language) || "English";

  const mappings: Array<{ set: string; name: string; number: string; setCode: string; cardName: string; category: Card["category"]; variant: string; sourceId: string; reason: string }> = [
    { set: "tcg classic", name: "articuno", number: "9", setCode: "clb", cardName: "Articuno", category: "Pokemon", variant: "holo", sourceId: "tcg-classic-clb-009", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "basic fighting energy", number: "34", setCode: "clv", cardName: "Basic Fighting Energy", category: "Energy", variant: "holo", sourceId: "tcg-classic-clv-034", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "basic grass energy", number: "33", setCode: "clv", cardName: "Basic Grass Energy", category: "Energy", variant: "holo", sourceId: "tcg-classic-clv-033", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "basic psychic energy", number: "34", setCode: "clb", cardName: "Basic Psychic Energy", category: "Energy", variant: "holo", sourceId: "tcg-classic-clb-034", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "basic water energy", number: "33", setCode: "clb", cardName: "Basic Water Energy", category: "Energy", variant: "holo", sourceId: "tcg-classic-clb-033", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "pokemon fan club (clb)", number: "22", setCode: "clb", cardName: "Pokemon Fan Club", category: "Trainer", variant: "holo", sourceId: "tcg-classic-clb-024", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "pokemon fan club (clc)", number: "22", setCode: "clc", cardName: "Pokemon Fan Club", category: "Trainer", variant: "holo", sourceId: "tcg-classic-clc-022", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "tcg classic", name: "pokemon fan club (clv)", number: "22", setCode: "clv", cardName: "Pokemon Fan Club", category: "Trainer", variant: "holo", sourceId: "tcg-classic-clv-022", reason: "Known TCG Classic deck printing; local catalog has no persisted SKU." },
    { set: "prismatic evolutions", name: "binding mochi (pokeball patt.)", number: "95", setCode: "sv08.5", cardName: "Binding Mochi", category: "Trainer", variant: "pokeball", sourceId: "sv08.5-095", reason: "Known Prismatic Evolutions #095 identity; Poké Ball pattern is not represented as a local SKU." },
    { set: "sword & shield", name: "pokegear 3.0", number: "174", setCode: "swsh1", cardName: "Pokégear 3.0", category: "Trainer", variant: "normal", sourceId: "swsh1-174", reason: "Known Sword & Shield Base Set #174 identity; local catalog has no persisted SKU." },
    { set: "trick or trade booster bundle 2023", name: "pikachu", number: "62", setCode: "tt2023", cardName: "Pikachu", category: "Pokemon", variant: "holo", sourceId: "tt2023-062", reason: "Known Trick or Trade 2023 #062 identity; local catalog has no persisted SKU." },
  ];

  const mapping = mappings.find((candidate) => candidate.set === setName && candidate.name === rawName && candidate.number === number);
  if (!mapping) return undefined;

  const printing: Printing = {
    printingId: `identity-${mapping.sourceId}`,
    catalogCardId: `identity-card-${mapping.setCode}-${normalizeText(mapping.cardName).replace(/[^a-z0-9]+/g, "-")}`,
    setId: `identity-set-${mapping.setCode}`,
    setCode: mapping.setCode,
    setName: input.setName ?? setName,
    cardNumber: mapping.number,
    language,
    rarity: "Unknown",
    sourceId: mapping.sourceId,
    active: true,
  };
  const card: Card = { catalogCardId: printing.catalogCardId, canonicalName: mapping.cardName, category: mapping.category };
  const variant: Variant = {
    variantId: `identity-variant-${mapping.sourceId}`,
    printingId: printing.printingId,
    variantType: mapping.variant,
    size: "standard",
    variantLabel: mapping.variant,
  };
  return { printing, card, variant, reason: mapping.reason };
}

export interface ResolveOptions {
  allowMissingCardNumber?: boolean;
}

export function resolveCardInput(catalog: Catalog, input: CardInput, options: ResolveOptions = {}): ResolveResult {
  const reasons: string[] = [];
  const setName = normalizeSetName(input.setName);
  let name = setName === "scarlet & violet energy"
    ? normalizeInventoryCardName(input.name).replace(/^basic /, "")
    : normalizeInventoryCardName(input.name);
  const setCode = normalizeText(input.setCode);
  const number = normalizeCardNumber(input.cardNumber);
  // Some marketplace invoices contain a seller/product typo. Keep this alias
  // narrowly scoped to the verified Mega Evolution printing instead of making
  // a global fuzzy-name match.
  if (setName === "mega evolution" && number === "176/132" && name === "wally's compass") {
    name = "wally's compassion";
  }
  const language = normalizeLanguage(input.language);
  const crackedIceEnergy = setName === "scarlet & violet energy" && /cracked ice holo/i.test(input.name ?? "");
  const variant = crackedIceEnergy ? "Normal" : normalizeVariant(input.variant);

  if (!setName && !setCode) reasons.push("Set is required.");
  if (!number && !options.allowMissingCardNumber) reasons.push("Card number is required.");
  if (!name && !number) reasons.push("Name or card number is required.");

  const identityOverride = knownIdentityOverride(input);
  if (identityOverride && !reasons.length) {
    return {
      state: "INCOMPLETE",
      printing: identityOverride.printing,
      card: identityOverride.card,
      variant: identityOverride.variant,
      candidates: [{ printing: identityOverride.printing, card: identityOverride.card, variants: [identityOverride.variant] }],
      reasons: [identityOverride.reason, "Identity is stable, but no local SKU is available; do not auto-allocate cost or sales against this printing."],
    };
  }

  let printings = catalog.printings.filter((printing) => {
    if (setName && normalizeSetName(printing.setName) !== setName) return false;
    if (setCode && normalizeText(printing.setCode) !== setCode) return false;
    if (number) {
      const crackedIceEnergy = setName === "scarlet & violet energy" && /cracked ice holo/i.test(input.name ?? "");
      const classicClbFanClub = setName === "tcg classic" && normalizeText(input.name).includes("pokemon fan club (clb)") && number === "22";
      const effectiveNumber = classicClbFanClub ? "24" : (crackedIceEnergy && normalizeText(input.name).startsWith("basic psychic energy") && number === "12" ? "13" : number);
      const candidateNumber = normalizeCardNumber(printing.cardNumber);
      if (effectiveNumber.includes("/")) {
        const inputNumber = effectiveNumber.split("/")[0];
        const candidateNumberWithoutTotal = candidateNumber.split("/")[0];
        if (candidateNumber !== effectiveNumber && candidateNumberWithoutTotal !== inputNumber) return false;
      } else if (candidateNumber !== effectiveNumber) {
        return false;
      }
    }
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
    else if (number) return { state: "CONFLICT", candidates: candidateRows(catalog, printings), reasons: [...reasons, "Name conflicts with the catalog printing identified by set/number."] };
    else return { state: "UNMATCHED", candidates: candidateRows(catalog, printings), reasons: [...reasons, "No printing with the supplied name exists in the selected set."] };
  }

  // A catalog merge can preserve the same TCGdex printing under different set-name
  // spellings. Deduplicate those source printings before declaring an input ambiguous.
  const uniquePrintings = Array.from(
    new Map(printings.map((printing) => [printing.sourceId ?? printing.printingId, printing])).values(),
  );
  printings = uniquePrintings;

  const candidates = candidateRows(catalog, printings);
  if (candidates.length !== 1) {
    return { state: "AMBIGUOUS", candidates, reasons: [...reasons, "More than one printing matches the supplied identity fields."] };
  }

  const row = candidates[0];
  const matchingVariants = row.variants.filter((candidate) => normalizeVariant(candidate.variantLabel) === variant || normalizeVariant(candidate.variantType) === variant);
  if (matchingVariants.length === 0) {
    return { state: "AMBIGUOUS", ...row, candidates, reasons: [...reasons, `Variant "${input.variant ?? "Normal"}" is not available for this printing.`] };
  }
  // Collapse duplicate semantic variants that can appear after catalog merges.
  const uniqueVariants = Array.from(
    new Map(
      matchingVariants.map((candidate) => [
        JSON.stringify({
          variantType: candidate.variantType,
          foilType: candidate.foilType,
          stamp: candidate.stamp ?? [],
          size: candidate.size,
          variantLabel: normalizeVariant(candidate.variantLabel),
        }),
        candidate,
      ]),
    ).values(),
  );

  // If the input only says "Holofoil" / "Reverse Holofoil", prefer the
  // un-stamped base treatment over a more specific stamped treatment.
  const baseVariants = uniqueVariants.filter((candidate) => !candidate.stamp?.length);
  const resolvedVariants = baseVariants.length === 1 ? baseVariants : uniqueVariants;

  if (resolvedVariants.length > 1) {
    return { state: "AMBIGUOUS", ...row, candidates, reasons: [...reasons, "Variant matches multiple catalog records."] };
  }

  const selectedVariant = resolvedVariants[0];
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
