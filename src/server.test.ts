import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, loadConfig } from "./config.ts";
import { Peers, parsePeerList } from "./peers.ts";
import { PRICES, costOf, priceFor, shortModel } from "./pricing.ts";
import type { ScanResult } from "./scanner.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";

const H = 3_600_000;
const NOW = Date.parse("2026-09-19T10:00:00Z");
const config: Config = { port: 0, role: "dashboard", dbPath: ":memory:", sources: ["/nowhere"], scanIntervalMs: 60_000 };
const scanResult: ScanResult = { sources: [], files: 0, newFiles: 0, updatedFiles: 0, turns: 0, sessions: 0, dispatches: 0, ms: 1 };

function seed(store: Store, machineTurns = 0): void {
  store.write(
    {
      sessions: [{ sessionId: "s1", cwd: "/home/me/app", project: "me/app", branch: "main", firstTs: NOW - 2 * H, lastTs: NOW - H, topic: null, topicCustom: false }],
      turns: [{ sessionId: "s1", ts: NOW - H, model: "claude-sonnet-5", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, tool: null, messageId: "m1", subagent: false, agentId: null }],
      dispatches: [],
    },
    { path: "/p/a.jsonl", source: "/p", size: 1, mtime: 1, offset: 1 },
  );
  for (let i = 0; i < machineTurns; i++)
    store.import("other", {
      sessions: [],
      turns: [{ machine: "", session_id: "r1", ts: NOW - H - i, model: "claude-haiku-4-5", input: 1, output: 1, cache_read: 0, cache_write: 0, tool: null, message_id: `r${i}`, subagent: 0, agent_id: null }],
      agents: [],
    });
}

describe("pricing", () => {
  test("families and cost", () => {
    expect(priceFor("claude-fable-5-1")).toEqual(PRICES[0]!.price);
    expect(priceFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(priceFor("<synthetic>")).toBeNull();
    expect(costOf("claude-sonnet-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(3);
    expect(costOf("claude-opus-5", { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(25 + 0.5 + 6.25, 9);
    expect(costOf("qwen", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(shortModel("claude-fable-5-1")).toBe("fable 5.1");
    expect(shortModel("claude-opus-5")).toBe("opus 5");
    expect(shortModel("<synthetic>")).toBe("<synthetic>");
  });
});

describe("routes", () => {
  const store = new Store(":memory:");
  seed(store, 2);
  let scans = 0;
  let clock = NOW;
  const app = createApp({ store, config, machine: "laptop", now: () => clock, log: () => {}, scan: async () => ({ ...scanResult, files: ++scans }) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: app.routes as never });
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  afterAll(() => {
    server.stop();
    store.close();
  });

  test("healthz and status", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const { body } = await get("/api/status");
    expect(body).toMatchObject({ ok: true, machine: "laptop", turns: 3, sessions: 1, files: 1, peersEnabled: false, peers: [] });
  });

  test("summary scans first when stale, names machines, filters by page names", async () => {
    const { body } = await get("/api/summary?range=today&tz=UTC");
    expect(scans).toBe(1);
    expect(body.ok).toBe(true);
    expect(body.machines).toEqual([
      { machine: "laptop", turns: 1, local: true },
      { machine: "other", turns: 2, local: false },
    ]);
    expect((body.totals as { tokens: number }).tokens).toBe(1104);
    // A second read within the freshness window does not scan again (the fake scan does not set last_scan, so it does).
    store.setMeta("last_scan", String(clock));
    const only = await get("/api/summary?range=today&tz=UTC&machines=other");
    expect(scans).toBe(1);
    expect((only.body.totals as { tokens: number }).tokens).toBe(4);
    expect(only.body.selectedMachines).toEqual(["other"]);
    expect((only.body.sessions as { machine: string }[])[0]?.machine).toBe("other");
    const bad = await get("/api/summary?range=yesterday");
    expect(bad.status).toBe(400);
  });

  test("export hands out local rows only, from a time", async () => {
    store.setMeta("last_scan", String(clock));
    const { body } = await get("/api/export?since=0");
    expect(body.machine).toBe("laptop");
    expect((body.turns as { message_id: string }[]).map((t) => t.message_id)).toEqual(["m1"]);
    expect((body.sessions as unknown[]).length).toBe(1);
    const later = await get(`/api/export?since=${NOW}`);
    expect((later.body.turns as unknown[]).length).toBe(0);
    expect((await get("/api/export?since=-1")).status).toBe(400);
  });

  test("refresh scans and the widget lists three lines", async () => {
    const r = await fetch(`${base}/api/refresh`, { method: "POST" });
    expect(((await r.json()) as { scan: { files: number } }).scan.files).toBe(2);
    store.setMeta("last_scan", String(clock));
    const { body } = await get("/api/widget?tz=UTC");
    const items = body.items as { text: string; url: string }[];
    expect(items).toHaveLength(3);
    expect(items[0]?.text).toMatch(/^Today · 1\.1K tokens · \$0\.005 · 2 sessions$/);
    expect(items[1]?.text).toContain("2 machines");
    expect(items[2]?.text).toMatch(/^Top model · claude-sonnet-5/);
  });
});

describe("loadConfig", () => {
  test("role defaults to dashboard and rejects other values", () => {
    expect(loadConfig({}, "/home/x").role).toBe("dashboard");
    expect(loadConfig({ USAGE_ROLE: " Collector " }, "/home/x").role).toBe("collector");
    expect(() => loadConfig({ USAGE_ROLE: "viewer" }, "/home/x")).toThrow(/USAGE_ROLE/);
  });
});

describe("collector role", () => {
  test("serves status, refresh and export; the page, the summary and the widget are off", async () => {
    const store = new Store(":memory:");
    seed(store);
    const app = createApp({ store, config: { ...config, role: "collector" }, machine: "box", page: "<html/>", now: () => NOW, log: () => {}, scan: async () => scanResult });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: app.routes as never });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(((await (await fetch(`${base}/api/status`)).json()) as { role: string }).role).toBe("collector");
      store.setMeta("last_scan", String(NOW));
      expect(((await (await fetch(`${base}/api/export?since=0`)).json()) as { turns: unknown[] }).turns).toHaveLength(1);
      expect((await fetch(`${base}/api/refresh`, { method: "POST" })).status).toBe(200);
      for (const path of ["/", "/api/summary?range=7d", "/api/widget"]) {
        const r = await fetch(base + path);
        expect(r.status).toBe(404);
        expect(await r.text()).toContain("collector");
      }
    } finally {
      server.stop();
      store.close();
    }
  });
});

describe("peers", () => {
  test("parsePeerList", () => {
    expect(parsePeerList(undefined)).toEqual([]);
    expect(parsePeerList("a=http://x:1/, b=https://y")).toEqual([
      { name: "a", url: "http://x:1" },
      { name: "b", url: "https://y" },
    ]);
    expect(() => parsePeerList("nourl")).toThrow(/name=url/);
    expect(() => parsePeerList("a=ftp://x")).toThrow(/http/);
    expect(() => parsePeerList("bad name=http://x")).toThrow(/name/);
  });

  test("discovers ai-usage on the space's peers, pulls since the newest turn held, records failures", async () => {
    const store = new Store(":memory:");
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/apps?all=1")) return Response.json({ apps: [{ name: "ai-usage" }, { name: "ai-usage", peer: "david" }, { name: "notes", peer: "david" }, { name: "ai-usage", peer: "down" }] });
      if (url.includes("/peers/david/")) {
        const since = Number(new URL(url).searchParams.get("since"));
        return Response.json({
          ok: true,
          machine: "david-box",
          sessions: [{ machine: "", session_id: "d1", cwd: "/srv/x", project: "srv/x", branch: "", first_ts: NOW - H, last_ts: NOW, topic: null, topic_custom: 0 }],
          turns: since === 0 ? [{ machine: "", session_id: "d1", ts: NOW - H, model: "claude-sonnet-5", input: 1, output: 1, cache_read: 0, cache_write: 0, tool: null, message_id: "d-m1", subagent: 0, agent_id: null }] : [],
          agents: [],
        });
      }
      if (url.includes("/peers/down/")) return new Response("nope", { status: 502 });
      if (url.startsWith("http://direct/")) return Response.json({ ok: false, error: "not an export here" });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const peers = new Peers({ store, spaceApiUrl: "http://127.0.0.1:8700/", direct: [{ name: "lan", url: "http://direct" }], fetch: fetchFn, now: () => NOW });
    expect(peers.enabled).toBe(true);
    const states = await peers.pullAll();
    expect(states.map((s) => [s.name, s.ok, s.turns])).toEqual([
      ["david", true, 1],
      ["down", false, 0],
      ["lan", false, 0],
    ]);
    expect(states.find((s) => s.name === "down")?.error).toMatch(/502/);
    expect(states.find((s) => s.name === "lan")?.error).toBe("not an export here");
    expect(store.machines()).toEqual([{ machine: "david", turns: 1 }]);
    expect(calls.find((c) => c.includes("/peers/david/"))).toBe("http://127.0.0.1:8700/api/peers/david/apps/ai-usage/proxy/api/export?since=0");
    // Second pull resumes two days before the newest turn held for that machine.
    await peers.pullAll();
    const second = calls.filter((c) => c.includes("/peers/david/"))[1]!;
    expect(Number(new URL(second).searchParams.get("since"))).toBe(NOW - H - 2 * 86_400_000);
    store.close();
  });
});

describe("store upserts", () => {
  let store: Store;
  beforeAll(() => {
    store = new Store(":memory:");
  });
  afterAll(() => store.close());

  test("session meta merges: earliest first, latest last, first cwd wins, custom topic sticks", () => {
    const base = { cwd: "", project: "unknown", branch: "", topic: null, topicCustom: false };
    store.write({ sessions: [{ ...base, sessionId: "s", firstTs: 200, lastTs: 300 }], turns: [], dispatches: [] }, { path: "/a", source: "/", size: 1, mtime: 1, offset: 1 });
    store.write({ sessions: [{ ...base, sessionId: "s", cwd: "/x/y", project: "x/y", branch: "b", firstTs: 100, lastTs: 250, topic: "ai", topicCustom: false }], turns: [], dispatches: [] }, { path: "/a", source: "/", size: 2, mtime: 2, offset: 2 });
    store.write({ sessions: [{ ...base, sessionId: "s", cwd: "/other", project: "other", firstTs: 150, lastTs: 400, topic: "mine", topicCustom: true }], turns: [], dispatches: [] }, { path: "/a", source: "/", size: 3, mtime: 3, offset: 3 });
    store.write({ sessions: [{ ...base, sessionId: "s", firstTs: 0, lastTs: 0, topic: "ai again", topicCustom: false }], turns: [], dispatches: [] }, { path: "/a", source: "/", size: 4, mtime: 4, offset: 4 });
    expect(store.sessionsSince(0)[0]).toMatchObject({ session_id: "s", cwd: "/x/y", project: "x/y", branch: "b", first_ts: 100, last_ts: 400, topic: "mine", topic_custom: 1 });
    expect(store.fileState("/a")).toMatchObject({ size: 4, offset: 4 });
  });
});

test("refresh, limits, status and widget include both providers without merging equal account ids", async () => {
  const { Limits } = await import("./limits.ts");
  const store = new Store(":memory:");
  const common = { machine: "local", now: () => NOW, credentials: async () => ({ token: "secret", account: "same", expiresAt: null, plan: "pro", tier: null }) };
  const limits = new Limits({ ...common, fetch: (async () => Response.json({ five_hour: { utilization: 10 } })) as unknown as typeof fetch });
  const codexLimits = new Limits({ ...common, provider: "codex", fetch: (async () => Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } })) as unknown as typeof fetch });
  const app = createApp({ store, config, machine: "local", limits, codexLimits, now: () => NOW, scan: async () => scanResult });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: app.routes as never });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const refresh = await (await fetch(`${base}/api/refresh`, { method: "POST" })).json();
    expect(refresh.limits.ok).toBe(true);
    expect(refresh.codexLimits.ok).toBe(true);
    const result = await (await fetch(`${base}/api/limits`)).json();
    expect(result.snapshots.map((s: { provider: string }) => s.provider)).toEqual(["claude", "codex"]);
    expect(JSON.stringify(result)).not.toContain("secret");
    const widget = await (await fetch(`${base}/api/widget`)).json();
    expect(widget.items.map((i: { text: string }) => i.text)).toEqual(expect.arrayContaining(["Claude · session 10%", "Codex · session 25%"]));
  } finally { server.stop(true); store.close(); }
});

test("manual refresh remains connected while a history scan exceeds the server idle timeout", async () => {
  const store = new Store(":memory:");
  const app = createApp({ store, config, machine: "local", scan: async () => { await Bun.sleep(1500); return scanResult; } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, routes: app.routes as never });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/refresh`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  } finally { server.stop(true); store.close(); }
});
