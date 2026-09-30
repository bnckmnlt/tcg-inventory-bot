export type MatchState = "EXACT" | "AMBIGUOUS" | "INCOMPLETE" | "CONFLICT" | "UNMATCHED";

export type CatalogCategory = "Pokemon" | "Trainer" | "Energy" | "Other";

export interface SetCatalog {
  setId: string;
  sourceSetId: string;
  setCode: string;
  setName: string;
  series?: string;
  releaseDate?: string;
  officialCardCount?: number;
  status: "active" | "inactive";
}

export interface ExternalIdMapping {
  externalIdMapId: string;
  entityType: "set" | "card" | "printing" | "variant" | "sku";
  internalId: string;
  source: string;
  externalId: string;
  status: "active" | "inactive";
}

export interface Card {
  catalogCardId: string;
  canonicalName: string;
  category: CatalogCategory;
  dexId?: number;
}

export interface Printing {
  printingId: string;
  catalogCardId: string;
  setId: string;
  setCode: string;
  setName: string;
  cardNumber: string;
  language: string;
  rarity?: string;
  illustrator?: string;
  sourceId?: string;
  tcgplayerProductId?: string;
  imageUrl?: string;
  active: boolean;
}

export interface Variant {
  variantId: string;
  printingId: string;
  variantType: string;
  foilType?: string;
  stamp?: string;
  size?: string;
  variantLabel: string;
  sourceVariantId?: string;
}

export interface Sku {
  skuId: string;
  variantId: string;
  condition: string;
  language: string;
  status: "active" | "inactive";
}

export interface Catalog {
  sets: SetCatalog[];
  cards: Card[];
  printings: Printing[];
  variants: Variant[];
  skus: Sku[];
  externalIdMappings: ExternalIdMapping[];
}

export interface CardInput {
  name?: string;
  setName?: string;
  setCode?: string;
  cardNumber?: string;
  language?: string;
  variant?: string;
  condition?: string;
}

export interface ResolveResult {
  state: MatchState;
  sku?: Sku;
  variant?: Variant;
  printing?: Printing;
  card?: Card;
  candidates: Array<{ printing: Printing; card: Card; variants: Variant[] }>;
  reasons: string[];
}
