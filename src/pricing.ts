/**
 * API-equivalent cost estimates. OpenAI prices and sources are below.
 * Anthropic API list prices (claude.com/pricing#api, June
 * 2026), in dollars per million tokens. A model is priced by the family name
 * its id contains; anything else (local models, `<synthetic>`, unknown ids)
 * has no price and shows as "n/a" rather than as zero. Subscription plans are
 * flat-rate, so for them the figure is what the same usage would have cost on
 * the API, not a bill.
 */

export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; serviceTier?: string | null };

/** First match wins; more specific names first. */
export const PRICES: { family: string; price: Price }[] = [
  { family: "fable", price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { family: "mythos", price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  { family: "opus", price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { family: "sonnet", price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { family: "haiku", price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];

/** OpenAI standard API prices verified on 2026-09-23. Exact ids only; unknown models stay unpriced.
 * https://developers.openai.com/api/docs/pricing and /models/<id>
 */
export const OPENAI_PRICES: Record<string, Price> = {
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.4": { input: 2.5, cacheRead: 0.25, cacheWrite: 0, output: 15 },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, cacheWrite: 0, output: 14 },
};
export const PRICING_AS_OF = "Anthropic 2026-06 / OpenAI 2026-09-23";
const openaiModel = (model: string) => model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");

export function priceFor(model: string): Price | null {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-")) return OPENAI_PRICES[openaiModel(m)] ?? null;
  for (const { family, price } of PRICES) if (m.includes(family)) return price;
  return null;
}

/** Dollars, or null when the model has no price. */
export function costOf(model: string, u: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const id = openaiModel(model);
  if (OPENAI_PRICES[id]) {
    if (u.cacheWrite > 0 && p.cacheWrite === 0) return null;
    const long = (id.startsWith("gpt-6-") || id.startsWith("gpt-5.6-") || id === "gpt-5.4") && u.input + u.cacheRead + u.cacheWrite > 272_000;
    const fast = u.serviceTier === "priority" || u.serviceTier === "fast";
    // Only apply tier multipliers for the models whose Fast rates were verified.
    if (fast && !id.startsWith("gpt-6-") && id !== "gpt-5.3-codex") return null;
    if (u.serviceTier && !["default", "standard", "priority", "fast"].includes(u.serviceTier)) return null;
    return ((u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) * (long ? 2 : 1) + u.output * p.output * (long ? 1.5 : 1)) * (fast ? 2 : 1) / 1e6;
  }
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
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
