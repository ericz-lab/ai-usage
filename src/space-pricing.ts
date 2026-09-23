import type { Store } from "./store.ts";

/** Version 1 of ai-space GET /api/model/pricing. No local GPT rate table. */
export type GptPrice = {
  input: number; cacheWrite: number | null; cacheRead: number; output: number;
  longContext: { threshold: number; inputMultiplier: number; outputMultiplier: number } | null;
  fastMultiplier: number | null;
};
export type GptCatalog = {
  version: 1; asOf: string; currency: "USD"; unitTokens: number; source: string;
  models: Record<string, GptPrice>;
};

export function parseCatalog(raw: unknown): GptCatalog {
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const number = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (!object(raw) || raw.version !== 1 || raw.currency !== "USD" || raw.unitTokens !== 1_000_000 ||
      typeof raw.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.asOf) || typeof raw.source !== "string" ||
      !object(raw.models) || Object.keys(raw.models).length > 500) throw new Error("invalid GPT pricing catalogue");
  for (const [id, p] of Object.entries(raw.models)) {
    if (!/^gpt-[a-z0-9.-]+$/.test(id) || !object(p) || ![p.input, p.cacheRead, p.output].every(number) ||
        !(p.cacheWrite === null || number(p.cacheWrite)) || !(p.fastMultiplier === null || number(p.fastMultiplier) && p.fastMultiplier > 0))
      throw new Error("invalid GPT model price");
    if (p.longContext !== null && (!object(p.longContext) || !number(p.longContext.threshold) || p.longContext.threshold <= 0 ||
        !number(p.longContext.inputMultiplier) || p.longContext.inputMultiplier <= 0 || !number(p.longContext.outputMultiplier) || p.longContext.outputMultiplier <= 0))
      throw new Error("invalid GPT long-context price");
  }
  return raw as GptCatalog;
}

/** Cache successful catalogues across restarts; outages never replace good prices. */
export class SpacePricing {
  catalog: GptCatalog | undefined;
  private fetchedAt: number | null = null;
  private error: string | null = null;
  private live = false;
  private attemptedAt = -Infinity;
  private inflight: Promise<void> | undefined;
  private readonly key: string;
  readonly url: string;

  constructor(private readonly opts: { store: Pick<Store, "getMeta" | "setMeta">; url?: string; fetch?: typeof fetch; now?: () => number }) {
    this.url = `${(opts.url?.trim() || "http://127.0.0.1:8700").replace(/\/+$/, "")}/api/model/pricing`;
    this.key = `gpt-pricing:${this.url}`;
    try {
      const cached = JSON.parse(opts.store.getMeta(this.key) ?? "null");
      if (cached) {
        this.catalog = parseCatalog(cached.catalog);
        this.fetchedAt = typeof cached.fetchedAt === "number" && Number.isFinite(cached.fetchedAt) ? cached.fetchedAt : null;
      }
    } catch { /* A broken cache is replaced by the next successful fetch. */ }
  }

  state() {
    return { url: this.url, asOf: this.catalog?.asOf ?? null, fetchedAt: this.fetchedAt,
      status: this.live ? "live" : this.catalog ? "cached" : "unavailable", error: this.error };
  }

  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    const now = (this.opts.now ?? Date.now)();
    if (!force && now - this.attemptedAt < 60_000) return Promise.resolve();
    this.attemptedAt = now;
    this.inflight = this.load(now).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async load(now: number) {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`pricing HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 256_000) throw new Error("pricing response too large");
      const catalog = parseCatalog(JSON.parse(text));
      this.opts.store.setMeta(this.key, JSON.stringify({ catalog, fetchedAt: now }));
      this.catalog = catalog;
      this.fetchedAt = now;
      this.live = true;
      this.error = null;
    } catch (e) {
      this.live = false;
      this.error = (e as Error).message;
    }
  }
}
