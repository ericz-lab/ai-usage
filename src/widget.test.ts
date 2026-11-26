import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "./store.ts";
import { type Block, widgetPayload } from "./widget.ts";

const H = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-19T10:00:00Z");
const MIDNIGHT = Date.parse("2026-09-19T00:00:00Z");
/** One turn of 1M uncached input tokens: $3 on claude-sonnet-5. */
const turn = (id: string, ts: number, model = "claude-sonnet-5") => ({ machine: "", session_id: `s-${id}`, ts, model, input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, tool: null, message_id: id, subagent: 0, agent_id: null });

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function payload(turns: ReturnType<typeof turn>[]) {
  const store = new Store(":memory:");
  stores.push(store);
  if (turns.length) store.import("peer", { sessions: [], agents: [], turns });
  return widgetPayload(store, { plans: [], codexPolled: true, now: NOW, tz: "UTC", lastScanAt: NOW });
}

const isText = (v: unknown) => (typeof v === "string" && v.length > 0) || (!!v && typeof v === "object" && Object.values(v).length > 0 && Object.values(v).every((x) => typeof x === "string" && x.length > 0));
/** A block against the block table of ai-space docs/app-spec.md. */
function expectValidBlock(b: Block) {
  expect(["metric", "trend", "progress", "gauge", "status"]).toContain(b.type);
  expect(isText(b.label)).toBe(true);
  if (b.caption !== undefined) expect(isText(b.caption)).toBe(true);
  if (b.type === "metric" || b.type === "progress") expect(b.value === null || typeof b.value === "number").toBe(true);
  if (b.type === "progress") expect(typeof b.max).toBe("number");
  if (b.type === "status") expect(isText(b.value)).toBe(true);
  if (b.type === "trend") {
    const points = b.points as { t: string; v: number | null }[];
    expect(points.length).toBeLessThanOrEqual(90);
    for (const p of points) {
      expect(p.t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.v === null || typeof p.v === "number").toBe(true);
    }
  }
  if (b.delta !== undefined) expect(typeof (b.delta as { value: unknown }).value).toBe("number");
}
function expectValidViews(w: ReturnType<typeof payload>) {
  const views = w.views!;
  expect(views.map((v) => [v.id, v.label])).toEqual([
    ["today", { en: "Today", zh: "今日" }],
    ["7d", { en: "7 days", zh: "7 天" }],
    ["30d", { en: "30 days", zh: "30 天" }],
  ]);
  for (const v of views) {
    expect(v.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}$/);
    expect(v.blocks.length).toBeGreaterThan(0);
    expect(v.blocks.length).toBeLessThanOrEqual(12);
    v.blocks.forEach(expectValidBlock);
  }
  expect(w.blocks).toEqual(views[0]!.blocks);
}

describe("widget views", () => {
  test("today, 7 days and 30 days; the top-level blocks are the today view, unchanged", () => {
    const turns = [turn("today", NOW - H), ...[1, 2, 4, 5, 6, 7].map((d) => turn(`d${d}`, MIDNIGHT - d * DAY + H))];
    const w = payload(turns);
    expectValidViews(w);
    expect(w.blocks.map((b) => b.type)).toEqual(["metric", "trend", "progress", "metric", "metric", "status"]);
    expect(w.blocks[0]).toMatchObject({ label: { en: "Today" }, value: 3 });
  });

  test("a range view: total cost with a delta against the range before it, daily bars, tokens and sessions, then quota and top model", () => {
    // This week: $3 a day except 3 days ago (quiet). The 7 days before it: two turns on day 8, one on day 13.
    const turns = [turn("today", NOW - H), ...[1, 2, 4, 5, 6].map((d) => turn(`d${d}`, MIDNIGHT - d * DAY + H)), turn("d8", MIDNIGHT - 8 * DAY + H), turn("d8b", MIDNIGHT - 8 * DAY + 2 * H), turn("d13", MIDNIGHT - 13 * DAY + H)];
    const w = payload(turns);
    expectValidViews(w);
    const week = w.views![1]!.blocks;
    expect(week.map((b) => b.type)).toEqual(["metric", "trend", "metric", "metric", "progress", "status"]);
    // Week = today + days 1..6 = 6 turns = $18; the 7 days before it hold days 7..13 = 3 turns = $9 -> +100%.
    expect(week[0]).toMatchObject({ value: 18, format: "currency", currency: "USD", delta: { value: 100, format: "percent", label: { en: "vs previous 7 days", zh: "较前 7 天" } }, url: "/?range=7d" });
    expect((week[1]!.points as { v: number | null }[]).map((p) => p.v)).toEqual([3, 3, 3, null, 3, 3, 3]);
    expect(week[2]).toMatchObject({ label: { en: "Tokens · 7 days" }, value: 6_000_000, format: "compact" });
    expect(week[3]).toMatchObject({ label: { en: "Sessions · 7 days" }, value: 6 });
    // The quota is the same block as in the today view.
    expect(week[4]).toEqual(w.blocks[2]!);
    expect(week[5]).toMatchObject({ label: { en: "Top model · 7 days" }, value: "sonnet 5" });

    const month = w.views![2]!.blocks;
    expect(month[0]).toMatchObject({ value: 27, url: "/?range=30d" });
    // The 30 days before the month have no turns and the history does not reach them: no delta.
    expect(month[0]!.delta).toBeUndefined();
    const points = month[1]!.points as { t: string; v: number | null }[];
    expect(points.length).toBe(30);
    expect(points[0]!.t).toBe("2026-08-21");
    expect(points.at(-1)).toEqual({ t: "2026-09-19", v: 3 });
    // Days without turns are null, never zero.
    expect(points.filter((p) => p.v === null).length).toBe(30 - 8);
    expect(points.some((p) => p.v === 0)).toBe(false);
    expect(month[5]).toMatchObject({ label: { en: "Top model · 30 days", zh: "主力模型 · 30 天" } });
  });

  test("no delta on a range when the history does not reach back over the range before it", () => {
    const w = payload([turn("today", NOW - H), turn("d2", MIDNIGHT - 2 * DAY + H)]);
    expectValidViews(w);
    expect(w.views![1]!.blocks[0]!.delta).toBeUndefined();
    expect(w.views![1]!.blocks[0]!.value).toBe(6);
  });

  test("an unpriced model makes a range cost null, not zero", () => {
    const w = payload([turn("q", MIDNIGHT - 2 * DAY + H, "qwen-local"), turn("t", NOW - H)]);
    expectValidViews(w);
    const hero = w.views![2]!.blocks[0]!;
    expect(hero.value).toBeNull();
    expect(hero.delta).toBeUndefined();
    expect((hero.caption as { en: string }).en).toContain("no price");
  });

  test("an empty database still gives a valid card with every view", () => {
    const w = payload([]);
    expect(w.ok).toBe(true);
    expectValidViews(w);
    for (const v of w.views!) {
      const trend = v.blocks.find((b) => b.type === "trend")!;
      expect((trend.points as { v: number | null }[]).every((p) => p.v === null)).toBe(true);
      expect(v.blocks.some((b) => b.type === "status")).toBe(false);
    }
  });
});
