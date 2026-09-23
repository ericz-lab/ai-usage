import { LOCALE, type Lang, translate } from "./i18n.ts";

/** Types of the service's JSON as the page sees them, plus formatting helpers. */

export type Totals = { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number; cost: number | null };

export type Summary = {
  range: string;
  from: number;
  to: number;
  tz: string;
  models: { model: string; turns: number; priced: boolean }[];
  selected: string[];
  machines: { machine: string; turns: number; local: boolean }[];
  selectedMachines: string[];
  totals: Totals & { sessions: number; days: number; subagentTokens: number; subagentTurns: number; perDay: { tokens: number; cost: number | null } };
  daily: { day: string; tokens: number; cost: number | null; byModel: Record<string, number> }[];
  hourly: { hour: number; tokens: number; cost: number | null; avgTokens: number }[];
  hourlyDays: number;
  byModel: (Totals & { model: string })[];
  byMachine: (Totals & { machine: string; sessions: number })[];
  byProject: (Totals & { machine: string; project: string; sessions: number })[];
  byBranch: (Totals & { machine: string; project: string; branch: string; sessions: number })[];
  sessions: (Totals & { sessionId: string; machine: string; project: string; branch: string; topic: string | null; model: string; first: number; last: number; durationMin: number; subagentTokens: number })[];
  subagents: (Totals & { type: string; dispatches: number })[];
  dispatches: { agentId: string; type: string; sessionId: string; machine: string; project: string; completedAt: number; status: string | null; tokens: number; cost: number | null; durationMs: number | null; toolUses: number | null }[];
};

export type Status = {
  ok: boolean;
  version: string;
  machine: string;
  pricingAsOf: string;
  sources: string[];
  files: number;
  sessions: number;
  turns: number;
  lastScan: number | null;
  scanning: boolean;
  peers: { name: string; lastPullAt: number | null; ok: boolean; error: string | null; turns: number }[];
  peersEnabled: boolean;
  limits: { ok: boolean; error: string | null; fetchedAt: number | null } | null;
  shared: { url: string; lastSyncAt: number | null; machines: { name: string; updatedAt: number | null; pulledAt: number | null; ok: boolean; error: string | null; rows: number }[] } | null;
};

export type Limit = { kind: string; group: string; label: string | null; percent: number; resetsAt: number | null; severity: string };
export type LimitsSnapshot = { provider?: "claude" | "codex"; machine: string; account: string | null; plan: string | null; tier: string | null; fetchedAt: number; limits: Limit[] };
export type LimitsReply = { ok: boolean; snapshots: LimitsSnapshot[] };

/** `max` + `default_claude_max_20x` -> `Max (20x)`. */
export const planName = (plan: string | null, tier: string | null): string => {
  const name = plan ? plan[0]!.toUpperCase() + plan.slice(1) : "";
  const x = tier?.match(/_(\d+x)$/)?.[1];
  return x ? `${name} (${x})` : name;
};

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  const j = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

export async function postJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { accept: "application/json" } });
  const j = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

/** 1234 -> 1.2K, 1234567 -> 1.23M, 2689400000 -> 2.69B. */
export const fmtTokens = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
};

export const fmtCost = (usd: number | null, lang: Lang): string => {
  if (usd === null) return translate(lang, "na");
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString(LOCALE[lang])}`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
};

export const fmtInt = (n: number, lang: Lang): string => n.toLocaleString(LOCALE[lang]);

export const fmtMinutes = (min: number, lang: Lang): string => (min >= 60 ? translate(lang, "hours", { h: Math.floor(min / 60), m: min % 60 }) : translate(lang, "minutes", { n: min }));

export const relTime = (ts: number, lang: Lang, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return translate(lang, "justNow");
  if (s < 3600) return translate(lang, "minAgo", { n: Math.round(s / 60) });
  if (s < 86400) return translate(lang, "hAgo", { n: Math.round(s / 3600) });
  return translate(lang, "dAgo", { n: Math.round(s / 86400) });
};

export const dateTime = (ts: number, lang: Lang): string => new Date(ts).toLocaleString(LOCALE[lang], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** `2026-09-19` -> `9/19` or `09-19` in Chinese; the year when the day is January 1st. */
export const shortDay = (day: string, lang: Lang): string => {
  const [y, m, d] = day.split("-") as [string, string, string];
  if (m === "01" && d === "01") return lang === "zh" ? `${y}年` : `${y}`;
  return lang === "zh" ? `${Number(m)}月${Number(d)}日` : `${Number(m)}/${Number(d)}`;
};
