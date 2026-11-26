import type { Limit, LimitsSnapshot } from "./limits.ts";
import { shortModel } from "./pricing.ts";
import type { GptCatalog } from "./space-pricing.ts";
import { type Summary, startOfDay, summary } from "./stats.ts";
import type { Store } from "./store.ts";

/**
 * The panel card `usage` (ai-space docs/app-spec.md, "widgets" and "Blocks"): `items` for older
 * panels, the state `blocks` of today, and `views` (the widget interactions contract) that switch
 * the card between today, the last 7 days and the last 30 days. Top-level `blocks` equals the
 * first view, so a panel without views shows the same card as before.
 *
 * Every number comes from stats.ts `summary()`, the same function the page's range views use.
 * Missing values are null: an unpriced model makes a cost null, a day without recorded turns is
 * a null point, and the Codex block is null when no reading covers now.
 */

/** Text in the panel's languages (ai-space docs/app-spec.md, "Blocks"). */
export type Text = { en: string; zh: string };
export type Block = { type: "metric" | "trend" | "progress" | "gauge" | "status"; label: Text; caption?: Text; url?: string; tone?: "positive" | "negative" | "warning" | "neutral"; [field: string]: unknown };
export type View = { id: string; label: Text; blocks: Block[] };

/** How long the card stays current: the panel refreshes every 5 minutes and a read rescans when the last scan is a minute old. */
export const WIDGET_STALE_AFTER = 1800;
const DAY = 86_400_000;

const fmtTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n));
const fmtCost = (c: number | null) => (c === null ? "n/a" : c >= 100 ? `$${c.toFixed(0)}` : c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(3)}`);
const limitName = (l: Limit) => (l.label ? `${l.group === "session" ? "session" : "week"} ${l.label}` : l.group === "session" ? "session" : "week");

/** Hundredths of a cent: a light day still shows its cost. */
const cents = (c: number) => Math.round(c * 10_000) / 10_000;
const percentChange = (value: number, base: number) => Math.round(((value - base) / base) * 1000) / 10;
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function resetText(at: number, now: number, tz: string): Text {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  const hm = `${parts.hour}:${parts.minute}`;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(at);
  const zhDay = WEEKDAYS_ZH[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day)] ?? day;
  if (at - now < 86_400_000) {
    const h = Math.max(1, Math.round((at - now) / 3_600_000));
    return { en: `resets in ${h}h`, zh: `${h} 小时后重置` };
  }
  return { en: `resets ${day} ${hm}`, zh: `${zhDay} ${hm} 重置` };
}

/** The Codex weekly window of the newest Codex snapshot: the unlabelled weekly limit, else null. */
function codexWeek(plans: LimitsSnapshot[]): { percent: number; resetsAt: number | null; fetchedAt: number } | null {
  const newest = plans.filter((p) => p.provider === "codex").sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  const week = newest?.limits.find((l) => l.group === "weekly" && l.label === null);
  return newest && week ? { percent: week.percent, resetsAt: week.resetsAt, fetchedAt: newest.fetchedAt } : null;
}

/** The Codex weekly quota as used percent; null value when polled but unknown; no block when not polled. Not range-dependent. */
function quotaBlock(plans: LimitsSnapshot[], codexPolled: boolean, now: number, tz: string): Block | null {
  const codex = codexWeek(plans);
  if (codex) {
    const reset = codex.resetsAt !== null && codex.resetsAt <= now;
    const used = reset ? null : Math.round(codex.percent);
    const left = used === null ? null : 100 - used;
    const when = codex.resetsAt !== null && !reset ? resetText(codex.resetsAt, now, tz) : null;
    return {
      type: "progress",
      label: { en: "Codex week used", zh: "Codex 周额度已用" },
      value: used,
      max: 100,
      format: "percent",
      caption:
        used === null
          ? { en: "window reset since the last reading", zh: "上次读取后已重置" }
          : { en: [`${used}% used`, `${left}% left`, when?.en].filter(Boolean).join(" · "), zh: [`已用 ${used}%`, `剩余 ${left}%`, when?.zh].filter(Boolean).join(" · ") },
      tone: used === null ? "neutral" : used > 95 ? "negative" : used > 80 ? "warning" : "neutral",
      url: "/",
    };
  }
  if (codexPolled) return { type: "progress", label: { en: "Codex week used", zh: "Codex 周额度已用" }, value: null, max: 100, format: "percent", caption: { en: "quota unknown: no Codex reading", zh: "额度未知：没有 Codex 读数" }, url: "/" };
  return null;
}

/** Daily cost bars; a day without turns or with an unpriced model is null. */
function costTrend(s: Summary, label: Text, url: string): Block {
  return { type: "trend", label, style: "bar", format: "currency", currency: "USD", points: s.daily.map((d) => ({ t: d.day, v: Object.keys(d.byModel).length === 0 || d.cost === null ? null : cents(d.cost) })), url };
}

/** The busiest model of a window, when it has one. */
function topModel(s: Summary, days: number, url: string): Block | null {
  const top = s.byModel[0];
  return top ? { type: "status", label: { en: `Top model · ${days} days`, zh: `主力模型 · ${days} 天` }, value: shortModel(top.model), caption: { en: `${fmtTokens(top.tokens)} tokens`, zh: `${fmtTokens(top.tokens)} Token` }, tone: "neutral", url } : null;
}

const present = (blocks: (Block | null)[]) => blocks.filter((b): b is Block => b !== null);

/** The today view (and the top-level `blocks`): today's cost, the 7-day bars, the Codex quota, today's tokens and sessions, the top model of 7 days. */
export function widgetBlocks(input: { today: Summary; week: Summary; prior: Summary | null; plans: LimitsSnapshot[]; codexPolled: boolean; machines: number; now: number; tz: string }): Block[] {
  const { today, week, prior, plans, now, tz } = input;
  const cost = today.totals.cost;
  const scope: Text = input.machines > 1 ? { en: `today · all ${input.machines} machines`, zh: `今日 · 全部 ${input.machines} 台机器` } : { en: "today", zh: "今日" };
  const avg = prior?.totals.perDay.cost ?? null;
  const hero: Block = {
    type: "metric",
    label: { en: "Today", zh: "今日费用" },
    value: cost === null ? null : cents(cost),
    format: "currency",
    currency: "USD",
    caption: cost === null ? { en: `${scope.en} · a model has no price`, zh: `${scope.zh} · 有模型无价格` } : scope,
    url: "/?range=today",
  };
  if (cost !== null && avg !== null && avg > 0) hero.delta = { value: percentChange(cost, avg), format: "percent", label: { en: "vs 7-day avg", zh: "较 7 日均值" } };
  return present([
    hero,
    costTrend(week, { en: "Last 7 days", zh: "近 7 天" }, "/?range=7d"),
    quotaBlock(plans, input.codexPolled, now, tz),
    { type: "metric", label: { en: "Tokens today", zh: "今日 Token" }, value: today.totals.tokens, format: "compact", url: "/?range=today" },
    { type: "metric", label: { en: "Sessions today", zh: "今日会话" }, value: today.totals.sessions, format: "number", url: "/?range=today" },
    topModel(week, 7, "/?range=7d"),
  ]).slice(0, 6);
}

/**
 * A range view (7 or 30 days): the range's total cost, with a delta against the same number of
 * days before it when the history reaches back that far; its daily cost bars; its tokens and
 * sessions; then the Codex quota (not range-dependent) and the range's top model.
 */
export function rangeBlocks(input: { days: 7 | 30; range: Summary; prior: Summary | null; plans: LimitsSnapshot[]; codexPolled: boolean; machines: number; now: number; tz: string }): Block[] {
  const { days, range, prior } = input;
  const url = `/?range=${days}d`;
  const cost = range.totals.cost;
  const scope: Text = input.machines > 1 ? { en: `${days} days · all ${input.machines} machines`, zh: `${days} 天 · 全部 ${input.machines} 台机器` } : { en: `last ${days} days`, zh: `近 ${days} 天` };
  const hero: Block = {
    type: "metric",
    label: { en: `${days} days`, zh: `${days} 天费用` },
    value: cost === null ? null : cents(cost),
    format: "currency",
    currency: "USD",
    caption: cost === null ? { en: `${scope.en} · a model has no price`, zh: `${scope.zh} · 有模型无价格` } : scope,
    url,
  };
  const base = prior?.totals.cost ?? null;
  if (cost !== null && base !== null && base > 0) hero.delta = { value: percentChange(cost, base), format: "percent", label: { en: `vs previous ${days} days`, zh: `较前 ${days} 天` } };
  return present([
    hero,
    costTrend(range, { en: "Daily cost", zh: "每日费用" }, url),
    { type: "metric", label: { en: `Tokens · ${days} days`, zh: `Token · ${days} 天` }, value: range.totals.tokens, format: "compact", url },
    { type: "metric", label: { en: `Sessions · ${days} days`, zh: `会话 · ${days} 天` }, value: range.totals.sessions, format: "number", url },
    quotaBlock(input.plans, input.codexPolled, input.now, input.tz),
    topModel(range, days, url),
  ]);
}

const VIEW_LABELS: Record<"today" | "7d" | "30d", Text> = { today: { en: "Today", zh: "今日" }, "7d": { en: "7 days", zh: "7 天" }, "30d": { en: "30 days", zh: "30 天" } };

/** The whole `GET /api/widget` answer. `lastScanAt` 0 = never scanned. */
export function widgetPayload(store: Store, input: { pricing?: GptCatalog; plans: LimitsSnapshot[]; codexPolled: boolean; now: number; tz: string; lastScanAt: number }) {
  const { plans, now, tz, codexPolled } = input;
  const read = (range: "today" | "7d" | "30d", at = now) => summary(store, { pricing: input.pricing, range, tz, now: at, sessionLimit: 1 });
  const today = read("today");
  const week = read("7d");
  const month = read("30d");
  const first = store.counts().firstTs;
  /** The window of `range` that ends just before `from`, when the history reaches its first day. */
  const before = (range: "7d" | "30d", from: number) => {
    const s = read(range, from - 1);
    return first !== null && first < s.from + DAY ? s : null;
  };
  const machines = today.machines.length;
  // The 7 full days before today, for the today hero's delta.
  const blocks = widgetBlocks({ today, week, prior: before("7d", startOfDay(now, tz)), plans, codexPolled, machines, now, tz });
  const views: View[] = [
    { id: "today", label: VIEW_LABELS.today, blocks },
    { id: "7d", label: VIEW_LABELS["7d"], blocks: rangeBlocks({ days: 7, range: week, prior: before("7d", week.from), plans, codexPolled, machines, now, tz }) },
    { id: "30d", label: VIEW_LABELS["30d"], blocks: rangeBlocks({ days: 30, range: month, prior: before("30d", month.from), plans, codexPolled, machines, now, tz }) },
  ].filter((v) => v.blocks.length > 0);

  const at = new Date(now).toISOString();
  const top = week.byModel[0];
  const machineCount = week.byMachine.length > 1 ? ` · ${week.byMachine.length} machines` : "";
  return {
    ok: true as const,
    asOf: new Date(input.lastScanAt || now).toISOString(),
    staleAfter: WIDGET_STALE_AFTER,
    blocks,
    ...(views.length >= 2 ? { views } : {}),
    items: [
      { text: `Today · ${fmtTokens(today.totals.tokens)} tokens · ${fmtCost(today.totals.cost)} · ${today.totals.sessions} sessions`, url: "/?range=today", time: at },
      { text: `7 days · ${fmtTokens(week.totals.tokens)} tokens · ${week.totals.cost === null && week.totals.pricedCost > 0 ? `≥ ${fmtCost(week.totals.pricedCost)}` : fmtCost(week.totals.cost)} · ${week.totals.perDay.cost === null && week.totals.perDay.pricedCost > 0 ? `≥ ${fmtCost(week.totals.perDay.pricedCost)}` : fmtCost(week.totals.perDay.cost)} per day${machineCount}`, url: "/?range=7d", time: at },
      ...(top ? [{ text: `Top model · ${top.model} · ${fmtTokens(top.tokens)} tokens in 7 days`, url: "/?range=7d" }] : []),
      ...plans.map((plan) => ({ text: `${plan.provider === "codex" ? "Codex" : "Claude"} · ${plan.limits.map((l) => `${limitName(l)} ${Math.round(l.resetsAt !== null && l.resetsAt <= now ? 0 : l.percent)}%`).join(" · ")}`, url: "/", time: new Date(plan.fetchedAt).toISOString() })),
    ],
  };
}
