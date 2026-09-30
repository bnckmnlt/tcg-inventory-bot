import { normalizeCardNumber, normalizeLanguage, normalizeSetName, normalizeText, normalizeVariant } from "./normalize.js";
import type { Card, Catalog, ExternalIdMapping, Printing, SetCatalog, Sku, Variant, CardInput } from "./types.js";
import { createHash } from "node:crypto";

interface SetBrief {
  id: string;
  name: string;
  cardCount?: { official?: number };
}

interface SetResponse extends SetBrief {
  cards: Array<{ id: string; localId: string; name: string }>;
}

interface TCGdexVariant {
  type: string;
  size?: string;
  variantId?: string;
  stamp?: string;
  thirdParty?: { tcgplayer?: number };
}

interface TCGdexCard {
  category: Card["category"];
  id: string;
  illustrator?: string;
  image?: string;
  localId: string;
  name: string;
  rarity?: string;
  set: { id: string; name: string; cardCount?: { official?: number } };
  variants_detailed?: TCGdexVariant[];
  dexId?: number[];
}

export interface RuntimeCandidate {
  sourceId: string;
  cardName: string;
  setId: string;
  setName: string;
  cardNumber: string;
  rarity?: string;
  language: string;
  variants: string[];
  tcgplayerProductIds: string[];
}

export interface RuntimeCatalogOptions {
  language?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function stableId(prefix: string, source: string): string {
  return prefix + "-" + createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function baseCardName(value: string): string {
  return normalizeText(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function legacySetCode(value: string): string | undefined {
  const match = value.match(/\((clb|clc|clv)\)\s*$/i);
  return match?.[1]?.toLowerCase();
}

function cardNumberMatches(input: string, candidate: string): boolean {
  const normalizedInput = normalizeCardNumber(input);
  const normalizedCandidate = normalizeCardNumber(candidate);
  if (normalizedInput === normalizedCandidate) return true;
  if (normalizedInput.includes("/")) return normalizedInput.split("/")[0] === normalizedCandidate.split("/")[0];
  return false;
}

function candidateVariantHints(value: string): string[] {
  const normalized = normalizeText(value);
  const hints: string[] = [];
  if (normalized.includes("cosmos")) hints.push("cosmos");
  if (normalized.includes("pokeball")) hints.push("pokeball");
  if (normalized.includes("masterball")) hints.push("masterball");
  if (normalized.includes("energy symbol")) hints.push("energy symbol");
  if (normalized.includes("reverse holo")) hints.push("reverse");
  if (normalized.includes("holo")) hints.push("holo");
  return hints;
}

function buildCatalog(cards: TCGdexCard[], language: string): Catalog {
  const sets: SetCatalog[] = [];
  const catalogCards: Card[] = [];
  const printings: Printing[] = [];
  const variants: Variant[] = [];
  const skus: Sku[] = [];
  const externalIdMappings: ExternalIdMapping[] = [];
  const seenSets = new Set<string>();
  const seenCards = new Map<string, Card>();

  for (const sourceCard of cards) {
    const setId = stableId("set", "tcgdex:set:" + sourceCard.set.id);
    if (!seenSets.has(sourceCard.set.id)) {
      sets.push({
        setId,
        sourceSetId: sourceCard.set.id,
        setCode: sourceCard.set.id,
        setName: sourceCard.set.name,
        officialCardCount: sourceCard.set.cardCount?.official,
        status: "active",
      });
      seenSets.add(sourceCard.set.id);
    }

    const catalogCardId = stableId("card", "tcgdex:card:" + sourceCard.name);
    let card = seenCards.get(catalogCardId);
    if (!card) {
      card = {
        catalogCardId,
        canonicalName: sourceCard.name,
        category: sourceCard.category,
        dexId: sourceCard.dexId?.[0],
      };
      seenCards.set(catalogCardId, card);
      catalogCards.push(card);
    }

    const printingId = stableId("printing", "tcgdex:printing:" + sourceCard.id + ":" + language);
    printings.push({
      printingId,
      catalogCardId,
      setId,
      setCode: sourceCard.set.id,
      setName: sourceCard.set.name,
      cardNumber: sourceCard.localId,
      language: language === "en" ? "English" : language,
      rarity: sourceCard.rarity,
      illustrator: sourceCard.illustrator,
      sourceId: sourceCard.id,
      imageUrl: sourceCard.image,
      active: true,
    });

    const detailedVariants = sourceCard.variants_detailed?.length
      ? sourceCard.variants_detailed
      : [{ type: "normal", size: "standard" }];

    for (const sourceVariant of detailedVariants) {
      const variantSource = sourceCard.id + ":" + (sourceVariant.variantId ?? sourceVariant.type) + ":" + (sourceVariant.size ?? "");
      const variantId = stableId("variant", "tcgdex:variant:" + variantSource);
      variants.push({
        variantId,
        printingId,
        variantType: sourceVariant.type,
        size: sourceVariant.size,
        stamp: sourceVariant.stamp,
        variantLabel: sourceVariant.stamp ? sourceVariant.type + " — " + sourceVariant.stamp : sourceVariant.type,
        sourceVariantId: sourceVariant.variantId,
      });

      for (const condition of ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"]) {
        skus.push({
          skuId: stableId("sku", "tcgdex:sku:" + variantId + ":" + condition + ":" + language),
          variantId,
          condition,
          language: language === "en" ? "English" : language,
          status: "active",
        });
      }
    }
  }

  return { sets, cards: catalogCards, printings, variants, skus, externalIdMappings };
}

export class TCGdexRuntime {
  private readonly language: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private setIndex?: SetBrief[];
  private readonly setCache = new Map<string, SetResponse>();
  private readonly cardCache = new Map<string, TCGdexCard>();

  constructor(options: RuntimeCatalogOptions = {}) {
    this.language = options.language ?? "en";
    this.baseUrl = options.baseUrl ?? "https://api.tcgdex.net/v2/" + this.language;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(this.baseUrl + path);
    if (!response.ok) throw new Error("TCGdex request failed: " + response.status + " " + path);
    return response.json() as Promise<T>;
  }

  private async getSetIndex(): Promise<SetBrief[]> {
    if (!this.setIndex) this.setIndex = await this.getJson<SetBrief[]>("/sets");
    return this.setIndex;
  }

  private async getSet(setId: string): Promise<SetResponse> {
    const cached = this.setCache.get(setId);
    if (cached) return cached;
    const set = await this.getJson<SetResponse>("/sets/" + encodeURIComponent(setId));
    this.setCache.set(setId, set);
    return set;
  }

  private async getCard(cardId: string): Promise<TCGdexCard> {
    const cached = this.cardCache.get(cardId);
    if (cached) return cached;
    const card = await this.getJson<TCGdexCard>("/cards/" + encodeURIComponent(cardId));
    this.cardCache.set(cardId, card);
    return card;
  }

  async findCandidates(input: CardInput): Promise<RuntimeCandidate[]> {
    const setName = normalizeSetName(input.setName);
    if (!setName) return [];

    const embeddedSetCode = legacySetCode(input.name ?? "");
    const sets = (await this.getSetIndex()).filter((set) => {
      if (embeddedSetCode && setName === "tcg classic") return normalizeText(set.id) === embeddedSetCode;
      if (setName === "tcg classic") return ["clb", "clc", "clv"].includes(normalizeText(set.id));
      return normalizeSetName(set.name) === setName;
    });
    const name = baseCardName(input.name ?? "");
    const number = normalizeCardNumber(input.cardNumber);
    const hints = candidateVariantHints(input.variant ?? "");

    const candidates: RuntimeCandidate[] = [];
    for (const setBrief of sets) {
      const set = await this.getSet(setBrief.id);
      const matchingBriefs = set.cards.filter((card) => {
        if (name && baseCardName(card.name) !== name) return false;
        if (number && number !== "1" && !cardNumberMatches(number, card.localId)) return false;
        return true;
      });
      for (const brief of matchingBriefs) {
        const card = await this.getCard(brief.id);
        const detailedVariants = card.variants_detailed?.length ? card.variants_detailed : [{ type: "normal" }];
        const labels = detailedVariants.map((variant) => variant.stamp ? variant.type + " — " + variant.stamp : variant.type);
        const variantText = labels.map(normalizeVariant);
        if (hints.length && !hints.some((hint) => variantText.some((value) => value.includes(hint)))) {
          // A parenthetical such as "(Full Art)" can describe the printing rather
          // than a physical variant, so only filter when we recognize a physical treatment.
          if (hints.some((hint) => ["cosmos", "pokeball", "masterball", "energy symbol"].includes(hint))) continue;
        }
        candidates.push({
          sourceId: card.id,
          cardName: card.name,
          setId: card.set.id,
          setName: card.set.name,
          cardNumber: card.localId,
          rarity: card.rarity,
          language: normalizeLanguage(this.language),
          variants: labels,
          tcgplayerProductIds: detailedVariants
            .map((variant) => variant.thirdParty?.tcgplayer)
            .filter((id): id is number => id !== undefined)
            .map(String),
        });
      }
    }

    return candidates;
  }

  async resolve(input: CardInput): Promise<{ candidates: RuntimeCandidate[]; catalog: Catalog }> {
    const candidates = await this.findCandidates(input);
    const cards = await Promise.all(candidates.map((candidate) => this.getCard(candidate.sourceId)));
    return { candidates, catalog: buildCatalog(cards, this.language) };
  }
}
