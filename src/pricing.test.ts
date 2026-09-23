import { expect, test } from "bun:test";
import { costOf as estimate, priceFor as price } from "./pricing.ts";
import { testCatalog } from "./testing-pricing.ts";
const costOf = (model: string, u: Parameters<typeof estimate>[1]) => estimate(model, u, testCatalog);
const priceFor = (model: string) => price(model, testCatalog);

test("Codex API equivalents price each token category and preserve unknown models", () => {
  expect(costOf("gpt-6-astra", { input: 1000, cacheRead: 2000, cacheWrite: 400, output: 500 })).toBeCloseTo(0.042);
  expect(priceFor("gpt-6-astra-2026-09-01")).toEqual(priceFor("gpt-6-astra"));
  expect(priceFor("gpt-6-astra-unlisted")).toBeNull();
  expect(costOf("gpt-unknown", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeNull();
});

test("long-context prices use full per-request input including cached tokens, plus explicit Fast tier", () => {
  const u = { input: 200000, cacheRead: 72000, cacheWrite: 0, output: 1000 };
  expect(costOf("gpt-6-astra", u)).toBeCloseTo(2.122);
  expect(costOf("gpt-6-astra", { ...u, cacheRead: 72001 })).toBeCloseTo(4.219002);
  expect(costOf("gpt-6-astra", { ...u, cacheRead: 72001, serviceTier: "priority" })).toBeCloseTo(8.438004);
  expect(costOf("gpt-5.3-codex", { input: 1000000, cacheRead: 0, cacheWrite: 0, output: 0, serviceTier: "fast" })).toBe(3.5);
  expect(costOf("gpt-6-astra", { ...u, serviceTier: "unlisted" })).toBeNull();
});
