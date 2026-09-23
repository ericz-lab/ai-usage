import type { GptCatalog } from "./space-pricing.ts";
/**
 * API-equivalent cost estimates. GPT prices come from ai-space.
 * Anthropic API list prices (claude.com/pricing#api, June
 * 2026), in dollars per million tokens. A model is priced by the family name
 * its id contains; anything else (local models, `<synthetic>`, unknown ids)
 * has no price and shows as "n/a" rather than as zero. Subscription plans are
 * flat-rate, so for them the figure is what the same usage would have cost on
 * the API, not a bill.
 */

export type Price = { input: number; output: number; cacheWrite: number | null; cacheRead: number };
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; serviceTier?: string | null };

/** First match wins; more specific names first. */
export const PRICES: { family: string; price: Price }[] = [
  { family: "fable", price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { family: "mythos", price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { family: "opus", price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { family: "sonnet", price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { family: "haiku", price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];

/** GPT dates come from the cached ai-space catalogue. */
export const PRICING_AS_OF = "Anthropic 2026-06";
const openaiModel = (model: string) => model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");

export function priceFor(model: string, catalog?: GptCatalog): Price | null {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-")) return catalog?.models[openaiModel(m)] ?? null;
  for (const { family, price } of PRICES) if (m.includes(family)) return price;
  return null;
}

/** Dollars, or null when the model has no price. */
export function costOf(model: string, u: TokenUsage, catalog?: GptCatalog): number | null {
  const p = priceFor(model, catalog);
  if (!p) return null;
  const id = openaiModel(model);
  if (id.startsWith("gpt-")) {
    const rate = catalog?.models[id];
    if (!rate || u.cacheWrite > 0 && rate.cacheWrite === null) return null;
    const long = rate.longContext && u.input + u.cacheRead + u.cacheWrite > rate.longContext.threshold ? rate.longContext : null;
    const fast = u.serviceTier === "priority" || u.serviceTier === "fast";
    if (fast && rate.fastMultiplier === null) return null;
    if (u.serviceTier && !["default", "standard", "priority", "fast"].includes(u.serviceTier)) return null;
    return ((u.input * rate.input + u.cacheWrite * (rate.cacheWrite ?? 0) + u.cacheRead * rate.cacheRead) * (long?.inputMultiplier ?? 1)
      + u.output * rate.output * (long?.outputMultiplier ?? 1)) * (fast ? rate.fastMultiplier! : 1) / catalog!.unitTokens;
  }
  return (u.input * p.input + u.output * p.output + u.cacheWrite * (p.cacheWrite ?? 0) + u.cacheRead * p.cacheRead) / 1e6;
}

/** `claude-haiku-4-5-20251001` -> `haiku 4.5`, `claude-fable-5-1` -> `fable 5.1`; unknown shapes are returned as is. */
export function shortModel(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Higher = more capable; used to name a session's primary model. */
export function modelRank(model: string): number {
  const m = model.toLowerCase();
  if (m === "gpt-6-astra") return 5;
  if (m.includes("-sol")) return 3;
  if (m.includes("-terra")) return 2;
  if (m.includes("-luna")) return 1;
  if (m.includes("fable") || m.includes("mythos")) return 5;
  if (m.includes("opus")) return 3;
  if (m.includes("sonnet")) return 2;
  if (m.includes("haiku")) return 1;
  return 0;
}
