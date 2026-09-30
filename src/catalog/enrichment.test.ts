import test from "node:test";
import assert from "node:assert/strict";
import type { Catalog } from "./types.js";
import { enrichCardInput } from "./enrichment.js";
import { TCGdexRuntime } from "./runtime.js";

function emptyCatalog(): Catalog {
  return { sets: [], cards: [], printings: [], variants: [], skus: [], externalIdMappings: [] };
}

function runtimeFor(payloads: Record<string, unknown>): TCGdexRuntime {
  return new TCGdexRuntime({
    fetch: async (url) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(target).pathname.replace("/v2/en", "");
      const body = payloads[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}

test("enrichment persists only one verified candidate and makes the next occurrence local", async () => {
  const payloads: Record<string, unknown> = {
    "/sets": [{ id: "swsh11", name: "Lost Origin" }],
    "/sets/swsh11": {
      id: "swsh11",
      name: "Lost Origin",
      cards: [{ id: "swsh11-123", localId: "123", name: "Radiant Hisuian Sneasler" }],
    },
    "/cards/swsh11-123": {
      category: "Pokemon",
      id: "swsh11-123",
      localId: "123",
      name: "Radiant Hisuian Sneasler",
      rarity: "Radiant Rare",
      set: { id: "swsh11", name: "Lost Origin" },
      variants_detailed: [{ type: "holo", size: "standard", thirdParty: { tcgplayer: 999 } }],
    },
  };

  const runtime = runtimeFor(payloads);
  const input = {
    name: "Radiant Hisuian Sneasler",
    setName: "SWSH11: Lost Origin",
    language: "English",
    variant: "Holo",
    condition: "Near Mint",
  };

  const first = await enrichCardInput(emptyCatalog(), input, runtime);
  assert.equal(first.state, "ENRICHED");
  assert.equal(first.resolved?.state, "EXACT");
  assert.equal(first.catalog?.printings.length, 1);
  assert.equal(first.catalog?.skus.length, 5);

  const second = await enrichCardInput(first.catalog!, input, runtime);
  assert.equal(second.state, "LOCAL");
  assert.equal(second.resolved?.state, "EXACT");
});

test("enrichment does not persist an ambiguous external result", async () => {
  const runtime = runtimeFor({
    "/sets": [{ id: "swsh06", name: "Chilling Reign" }],
    "/sets/swsh06": {
      id: "swsh06",
      name: "Chilling Reign",
      cards: [
        { id: "swsh06-001", localId: "001", name: "Gengar" },
        { id: "swsh06-002", localId: "002", name: "Gengar" },
      ],
    },
    "/cards/swsh06-001": {
      category: "Pokemon", id: "swsh06-001", localId: "001", name: "Gengar",
      rarity: "Holo Rare", set: { id: "swsh06", name: "Chilling Reign" },
      variants_detailed: [{ type: "reverse", size: "standard" }],
    },
    "/cards/swsh06-002": {
      category: "Pokemon", id: "swsh06-002", localId: "002", name: "Gengar",
      rarity: "Holo Rare", set: { id: "swsh06", name: "Chilling Reign" },
      variants_detailed: [{ type: "reverse", size: "standard" }],
    },
  });

  const result = await enrichCardInput(emptyCatalog(), {
    name: "Gengar",
    setName: "SWSH06: Chilling Reign",
    language: "English",
    variant: "Reverse Holo",
    condition: "Near Mint",
  }, runtime);

  assert.equal(result.state, "AMBIGUOUS");
  assert.equal(result.catalog, undefined);
  assert.equal(result.externalCandidates.length, 2);
});

test("enrichment leaves a missing external card pending", async () => {
  const runtime = runtimeFor({
    "/sets": [{ id: "xy12", name: "Evolutions" }],
    "/sets/xy12": { id: "xy12", name: "Evolutions", cards: [] },
  });

  const result = await enrichCardInput(emptyCatalog(), {
    name: "Gastly",
    setName: "XY - Evolutions",
    language: "English",
    variant: "Reverse Holo",
    condition: "Near Mint",
  }, runtime);

  assert.equal(result.state, "NOT_FOUND");
  assert.match(result.reason ?? "", /no matching candidates/i);
});
