import { expect, test } from "bun:test";
import { SpacePricing, parseCatalog } from "./space-pricing.ts";
import { testCatalog } from "./testing-pricing.ts";
import { costOf } from "./pricing.ts";
import { Store } from "./store.ts";

const usage = { input: 1000, cacheWrite: 0, cacheRead: 0, output: 0 };

test("refresh replaces rates, caches them across instances and keeps them through outages", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  let body: unknown = testCatalog;
  const fetcher = (async () => { calls++; return Response.json(body); }) as unknown as typeof fetch;
  try {
    const prices = new SpacePricing({ store, fetch: fetcher, now: () => 1000 });
    expect(costOf("gpt-6-astra", usage, prices.catalog)).toBeNull();
    await Promise.all([prices.refresh(), prices.refresh()]);
    expect(calls).toBe(1);
    expect(costOf("gpt-6-astra", usage, prices.catalog)).toBe(0.01);
    expect(prices.state()).toMatchObject({ status: "live", asOf: "2026-09-23", fetchedAt: 1000 });
    body = { ...testCatalog, models: { ...testCatalog.models, "gpt-6-astra": { ...testCatalog.models["gpt-6-astra"], input: 20 } } };
    await prices.refresh();
    expect(calls).toBe(1);
    await prices.refresh(true);
    expect(costOf("gpt-6-astra", usage, prices.catalog)).toBe(0.02);
    const offline = new SpacePricing({ store, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await offline.refresh();
    expect(offline.state()).toMatchObject({ status: "cached", error: "offline" });
    expect(costOf("gpt-6-astra", usage, offline.catalog)).toBe(0.02);
    const other = new SpacePricing({ store, url: "http://other.test", fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
    await other.refresh();
    expect(other.state().status).toBe("unavailable");
    expect(other.catalog).toBeUndefined();
    body = { ...testCatalog, version: 2 };
    await prices.refresh(true);
    expect(prices.state().status).toBe("cached");
    expect(costOf("gpt-6-astra", usage, prices.catalog)).toBe(0.02);
  } finally { store.close(); }
});

test("rejects unsupported units, malformed rates and multipliers", () => {
  for (const patch of [{ version: 2 }, { currency: "CNY" }, { unitTokens: 1000 }, { models: [] }, { asOf: "unknown" }]) {
    expect(() => parseCatalog({ ...testCatalog, ...patch })).toThrow();
  }
  for (const patch of [{ input: -1 }, { output: Infinity }, { cacheRead: "1" }, { fastMultiplier: 0 }, { longContext: {} }]) {
    expect(() => parseCatalog({ ...testCatalog, models: { "gpt-test": { ...testCatalog.models["gpt-6-astra"], ...patch } } })).toThrow();
  }
  expect(costOf("gpt-5.3-codex", { ...usage, cacheWrite: 1 }, testCatalog)).toBeNull();
  expect(costOf("haiku", usage)).toBe(0.001);
});

test("invalid cached data does not prevent fetching a valid catalogue", async () => {
  const store = new Store(":memory:");
  try {
    store.setMeta("gpt-pricing:http://127.0.0.1:8700/api/model/pricing", "broken");
    const prices = new SpacePricing({ store, fetch: (async () => Response.json(testCatalog)) as unknown as typeof fetch });
    await prices.refresh();
    expect(prices.state().status).toBe("live");
  } finally { store.close(); }
});
