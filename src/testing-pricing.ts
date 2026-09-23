import type { GptCatalog } from "./space-pricing.ts";

/** Synthetic API response for pricing tests; production has no fallback rate table. */
export const testCatalog: GptCatalog = {
  version: 1, asOf: "2026-09-23", currency: "USD", unitTokens: 1_000_000, source: "https://example.test/pricing",
  models: {
    "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, longContext: { threshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 }, fastMultiplier: 2 },
    "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50,
      longContext: { threshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 }, fastMultiplier: 2 },
    "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, cacheWrite: null, output: 14, longContext: null, fastMultiplier: 2 },
  },
};
