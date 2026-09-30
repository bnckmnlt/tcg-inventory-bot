import assert from "node:assert/strict";
import test from "node:test";
import { sampleCatalog } from "./sample.js";
import { resolveCardInput } from "./resolver.js";

test("resolves Charizard ex 151 #006 deterministically", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "6/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-charizard-151-006-nm");
});

test("distinguishes two Charizard ex printings by number", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Charizard ex",
    setName: "151",
    cardNumber: "199/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-charizard-151-199-nm");
});

test("does not use name alone to resolve a duplicated name", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Lucian",
    condition: "Near Mint",
    language: "English",
  });
  assert.equal(result.state, "AMBIGUOUS");
});

test("handles a variant without changing the underlying printing", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Pikachu",
    setName: "Scarlet & Violet Black Star Promos",
    cardNumber: "088",
    language: "English",
    variant: "Poké Ball Pattern",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.variant?.variantLabel, "Poké Ball Pattern");
});

test("keeps Basic Psychic Energy identified by printing number", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Basic Psychic Energy",
    setName: "151",
    cardNumber: "207/165",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.sku?.skuId, "sku-psychic-151-207-nm");
});

test("strips known V2 printing suffixes from the card name", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Drifloon (Cosmos Holo)",
    setName: "Example Set C",
    cardNumber: "050/100",
    language: "English",
    variant: "Normal",
    condition: "Near Mint",
  });
  assert.equal(result.state, "EXACT");
  assert.equal(result.variant?.variantLabel, "Normal");
});

test("flags a name conflict instead of silently accepting it", () => {
  const result = resolveCardInput(sampleCatalog, {
    name: "Drifblim",
    setName: "Example Set C",
    cardNumber: "050/100",
    language: "English",
    condition: "Near Mint",
  });
  assert.equal(result.state, "CONFLICT");
  assert.match(result.reasons.join(" "), /conflicts with the catalog printing/);
});
