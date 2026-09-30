import test from "node:test";
import assert from "node:assert/strict";
import { TCGdexRuntime } from "./runtime.js";

test("runtime catalog resolves only the requested set/card data", async () => {
  const requests: string[] = [];
  const payloads: Record<string, unknown> = {
    "/sets": [{ id: "sv03.5", name: "151" }],
    "/sets/sv03.5": {
      id: "sv03.5",
      name: "151",
      cards: [
        { id: "sv03.5-006", localId: "006", name: "Charizard ex" },
        { id: "sv03.5-199", localId: "199", name: "Charizard ex" },
      ],
    },
    "/cards/sv03.5-006": {
      category: "Pokemon",
      id: "sv03.5-006",
      localId: "006",
      name: "Charizard ex",
      rarity: "Double rare",
      set: { id: "sv03.5", name: "151" },
      variants_detailed: [{ type: "normal", size: "standard", thirdParty: { tcgplayer: 123 } }],
    },
    "/cards/sv03.5-199": {
      category: "Pokemon",
      id: "sv03.5-199",
      localId: "199",
      name: "Charizard ex",
      rarity: "Special illustration rare",
      set: { id: "sv03.5", name: "151" },
      variants_detailed: [{ type: "normal", size: "standard", thirdParty: { tcgplayer: 456 } }],
    },
  };

  const runtime = new TCGdexRuntime({
    fetch: async (url) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(target).pathname.replace("/v2/en", "");
      requests.push(path);
      const body = payloads[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await runtime.resolve({ name: "Charizard ex", setName: "151", cardNumber: "199", language: "English", variant: "Normal", condition: "Near Mint" });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.catalog.printings.length, 1);
  assert.equal(result.candidates[0].cardNumber, "199");
  assert.deepEqual(requests, ["/sets", "/sets/sv03.5", "/cards/sv03.5-199"]);
});

test("runtime maps SVE Basic Energy names to Scarlet & Violet Energy", async () => {
  const payloads: Record<string, unknown> = {
    "/sets": [{ id: "sve", name: "Scarlet & Violet Energy" }],
    "/sets/sve": {
      id: "sve", name: "Scarlet & Violet Energy",
      cards: [{ id: "sve-004", localId: "004", name: "Lightning Energy" }],
    },
    "/cards/sve-004": {
      category: "Energy", id: "sve-004", localId: "004", name: "Lightning Energy",
      set: { id: "sve", name: "Scarlet & Violet Energy" },
      variants_detailed: [{ type: "holo", size: "standard" }],
    },
  };
  const runtime = new TCGdexRuntime({
    fetch: async (url) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(target).pathname.replace("/v2/en", "");
      const body = payloads[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await runtime.resolve({ name: "Basic Lightning Energy", setName: "SVE: Scarlet & Violet Energies", cardNumber: "1", variant: "Holofoil", language: "English", condition: "Near Mint" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].cardNumber, "004");
});

test("runtime resolves TCG Classic deck-specific printings without TCGdex set endpoints", async () => {
  const runtime = new TCGdexRuntime({ fetch: async () => new Response("should not fetch", { status: 500 }) });
  const result = await runtime.resolve({ name: "Pokemon Fan Club (CLC)", setName: "TCG Classic", cardNumber: "1", variant: "Holofoil", language: "English", condition: "Near Mint" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceId, "tcg-classic-clc-022");
  assert.equal(result.candidates[0].cardNumber, "022");
});
