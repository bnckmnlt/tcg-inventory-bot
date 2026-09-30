import test from "node:test";
import assert from "node:assert/strict";
import { TCGdexRuntime } from "./runtime.js";
import { resolveCardInput } from "./resolver.js";

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
      cards: [
        { id: "sve-012", localId: "012", name: "Lightning Energy" },
        { id: "sve-013", localId: "013", name: "Psychic Energy" },
      ],
    },
    "/cards/sve-012": {
      category: "Energy", id: "sve-012", localId: "012", name: "Lightning Energy",
      set: { id: "sve", name: "Scarlet & Violet Energy" },
      variants_detailed: [{ type: "normal", size: "standard" }],
    },
    "/cards/sve-013": {
      category: "Energy", id: "sve-013", localId: "013", name: "Psychic Energy",
      set: { id: "sve", name: "Scarlet & Violet Energy" },
      variants_detailed: [{ type: "normal", size: "standard" }],
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

  for (const [name, number, expectedNumber] of [["Basic Lightning Energy", "012", "012"], ["Basic Psychic Energy", "12", "013"]] as const) {
    const result = await runtime.resolve({
      name: `${name} (Cracked Ice Holo)`,
      setName: "SVE: Scarlet & Violet Energies",
      cardNumber: number,
      variant: "Cracked Ice Holo",
      language: "English",
      condition: "Near Mint",
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].cardNumber, expectedNumber);

    const resolved = resolveCardInput(result.catalog, {
      name: `${name} (Cracked Ice Holo)`,
      setName: "SVE: Scarlet & Violet Energies",
      cardNumber: number,
      variant: "Cracked Ice Holo",
      language: "English",
      condition: "Near Mint",
    });
    assert.equal(resolved.state, "EXACT");
    assert.equal(resolved.variant?.variantLabel, "normal");
  }
});

test("runtime uses TCGdex reverse-holofoil pricing when variant details omit the reverse treatment", async () => {
  const payloads: Record<string, unknown> = {
    "/sets": [{ id: "xy12", name: "Evolutions" }],
    "/sets/xy12": {
      id: "xy12", name: "Evolutions",
      cards: [{ id: "xy12-47", localId: "47", name: "Gastly" }],
    },
    "/cards/xy12-47": {
      category: "Pokemon", id: "xy12-47", localId: "47", name: "Gastly",
      rarity: "Common", set: { id: "xy12", name: "Evolutions" },
      variants_detailed: [{ type: "normal", size: "standard", variantId: "generated" }],
      pricing: { tcgplayer: { "reverse-holofoil": { productId: 124061 } } },
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

  const result = await runtime.resolve({
    name: "Gastly",
    setName: "XY - Evolutions",
    language: "English",
    variant: "Reverse Holo",
    condition: "Near Mint",
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].variants, ["normal", "reverse"]);
  const resolved = resolveCardInput(result.catalog, {
    name: "Gastly",
    setName: "XY - Evolutions",
    language: "English",
    variant: "Reverse Holo",
    condition: "Near Mint",
  }, { allowMissingCardNumber: true });
  assert.equal(resolved.state, "EXACT");
});

test("runtime resolves TCG Classic deck-specific printings without TCGdex set endpoints", async () => {
  const runtime = new TCGdexRuntime({ fetch: async () => new Response("should not fetch", { status: 500 }) });
  const result = await runtime.resolve({ name: "Pokemon Fan Club (CLC)", setName: "TCG Classic", cardNumber: "1", variant: "Holofoil", language: "English", condition: "Near Mint" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceId, "tcg-classic-clc-022");
  assert.equal(result.candidates[0].cardNumber, "022");
});
