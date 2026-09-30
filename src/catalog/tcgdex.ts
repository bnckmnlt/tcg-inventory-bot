import { createHash } from "node:crypto";
import type { Catalog, Card, Printing, Variant, Sku, SetCatalog, ExternalIdMapping } from "./types.js";

export interface TCGdexImportOptions {
  language?: string;
  setIds: string[];
  conditions?: string[];
}

interface TCGdexSet extends SetCatalogSource {
  cards: Array<{ id: string; localId: string; name: string }>;
}

interface SetCatalogSource {
  id: string;
  name: string;
  cardCount?: { official?: number };
}

interface TCGdexVariant {
  type: string;
  size?: string;
  variantId?: string;
  stamp?: string;
  thirdParty?: { tcgplayer?: number };
}

interface TCGdexCard {
  category: string;
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

function stableId(prefix: string, source: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return prefix + "-" + digest;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(baseUrl + path);
  if (!response.ok) throw new Error("TCGdex request failed: " + response.status + " " + path);
  return response.json() as Promise<T>;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function importTCGdex(options: TCGdexImportOptions): Promise<Catalog> {
  const language = options.language ?? "en";
  const conditions = options.conditions ?? ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
  const baseUrl = "https://api.tcgdex.net/v2/" + language;

  const sets: SetCatalog[] = [];
  const cards: Card[] = [];
  const printings: Printing[] = [];
  const variants: Variant[] = [];
  const skus: Sku[] = [];
  const externalIdMappings: ExternalIdMapping[] = [];
  const seenCards = new Map<string, Card>();
  const seenSets = new Set<string>();

  for (const setId of options.setIds) {
    const set = await getJson<TCGdexSet>(baseUrl, "/sets/" + encodeURIComponent(setId));
    const internalSetId = stableId("set", "tcgdex:set:" + set.id);

    if (!seenSets.has(set.id)) {
      sets.push({
        setId: internalSetId,
        sourceSetId: set.id,
        setCode: set.id,
        setName: set.name,
        officialCardCount: set.cardCount?.official,
        status: "active",
      });
      externalIdMappings.push({
        externalIdMapId: stableId("map", "tcgdex:set:" + set.id),
        entityType: "set",
        internalId: internalSetId,
        source: "tcgdex",
        externalId: set.id,
        status: "active",
      });
      seenSets.add(set.id);
    }

    const sourceCards = await mapWithConcurrency(
      set.cards,
      12,
      (brief) => getJson<TCGdexCard>(baseUrl, "/cards/" + encodeURIComponent(brief.id)),
    );

    for (const sourceCard of sourceCards) {
      const catalogCardId = stableId("card", "tcgdex:card:" + sourceCard.name);
      let card = seenCards.get(catalogCardId);

      if (!card) {
        card = {
          catalogCardId,
          canonicalName: sourceCard.name,
          category: sourceCard.category as Card["category"],
          dexId: sourceCard.dexId?.[0],
        };
        seenCards.set(catalogCardId, card);
        cards.push(card);
      }

      const printingId = stableId("printing", "tcgdex:printing:" + sourceCard.id + ":" + language);
      printings.push({
        printingId,
        catalogCardId,
        setId: internalSetId,
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

      externalIdMappings.push({
        externalIdMapId: stableId("map", "tcgdex:printing:" + sourceCard.id + ":" + language),
        entityType: "printing",
        internalId: printingId,
        source: "tcgdex",
        externalId: sourceCard.id,
        status: "active",
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

        externalIdMappings.push({
          externalIdMapId: stableId("map", "tcgdex:variant:" + variantSource),
          entityType: "variant",
          internalId: variantId,
          source: "tcgdex",
          externalId: sourceVariant.variantId ?? sourceVariant.type,
          status: "active",
        });

        if (sourceVariant.thirdParty?.tcgplayer !== undefined) {
          externalIdMappings.push({
            externalIdMapId: stableId("map", "tcgplayer:variant:" + variantSource),
            entityType: "variant",
            internalId: variantId,
            source: "tcgplayer",
            externalId: String(sourceVariant.thirdParty.tcgplayer),
            status: "active",
          });
        }

        for (const condition of conditions) {
          const skuId = stableId("sku", "tcgdex:sku:" + variantId + ":" + condition + ":" + language);
          skus.push({
            skuId,
            variantId,
            condition,
            language: language === "en" ? "English" : language,
            status: "active",
          });
          externalIdMappings.push({
            externalIdMapId: stableId("map", "tcgdex:sku:" + variantId + ":" + condition + ":" + language),
            entityType: "sku",
            internalId: skuId,
            source: "tcgdex",
            externalId: sourceCard.id + ":" + (sourceVariant.variantId ?? sourceVariant.type) + ":" + condition + ":" + language,
            status: "active",
          });
        }
      }
    }
  }

  return { sets, cards, printings, variants, skus, externalIdMappings };
}
