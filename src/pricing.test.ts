import { expect, test } from "bun:test";
import { costOf as estimate, modelRank, priceFor as price, shortModel } from "./pricing.ts";
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

test("DeepSeek list prices cover both routes and leave unknown ids unpriced", () => {
  expect(costOf("deepseek-flash", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(0.3);
  expect(costOf("deepseek-flash", { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 })).toBeCloseTo(1.206);
  expect(costOf("deepseek-v4-flash", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.3);
  expect(costOf("deepseek-v4-pro", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 })).toBeCloseTo(5.28);
  expect(priceFor("deepseek-unknown")).toBeNull();
  expect(costOf("deepseek-unknown", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  expect(shortModel("deepseek-flash")).toBe("DeepSeek Flash");
  expect(shortModel("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  expect(modelRank("deepseek-v4-pro")).toBeGreaterThan(modelRank("deepseek-flash"));
});

test("Claude models take ai-space's list price per id, the family table only for an id it does not list", () => {
  const catalog = { ...testCatalog, anthropic: { source: "https://models.dev", fetchedAt: "2026-11-24T12:00:00.000Z", unitTokens: 1_000_000 as const, models: {
    "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, longContext: null },
    "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5, longContext: null },
    "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5, longContext: { threshold: 100000, inputMultiplier: 5, outputMultiplier: 5 } },
    "claude-sonnet-9": { input: 2, cacheWrite: null, cacheRead: 0.2, output: 10, longContext: null },
  } } };
  const m = 1_000_000;
  expect(estimate("claude-opus-5-5", { input: m, cacheRead: m, cacheWrite: m, output: m }, catalog)).toBeCloseTo(4 + 0.2 + 5 + 20);
  expect(estimate("claude-opus-5-5", { input: m, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(5); // no catalogue: the family table
  expect(price("claude-haiku-4-5-20251001", catalog)).toMatchObject({ input: 1, output: 5 });
  // Haiku 5.5: the whole call at five times the rates once its prompt is over 100K tokens.
  expect(estimate("claude-haiku-5-5", { input: 100000, cacheRead: 0, cacheWrite: 0, output: m }, catalog)).toBeCloseTo(0.01 + 0.5);
  expect(estimate("claude-haiku-5-5", { input: 100001, cacheRead: 0, cacheWrite: 0, output: m }, catalog)).toBeCloseTo((100001 * 0.1 / m + 0.5) * 5);
  expect(estimate("claude-sonnet-9", { input: 1, cacheRead: 0, cacheWrite: 1, output: 0 }, catalog)).toBeNull();
  expect(estimate("claude-fable-9", { input: m, cacheRead: 0, cacheWrite: 0, output: 0 }, catalog)).toBe(10); // not listed: family
});
