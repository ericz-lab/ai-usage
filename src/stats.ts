import { costOf, modelRank, priceFor } from "./pricing.ts";
import type { Store, TurnRow } from "./store.ts";

/**
 * The dashboard's numbers, computed from the store for one window, one model
 * filter and the viewer's time zone. Days and hours are the viewer's, so
 * "today" is their today; the turns of a window are pulled once and
 * aggregated here rather than in SQL, which keeps the time-zone math in one
 * place and costs milliseconds for a month of heavy use.
 */

export const RANGES = ["5h", "today", "7d", "30d", "90d", "all"] as const;
export type Range = (typeof RANGES)[number];

export type Totals = { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; tokens: number; cost: number | null };

export type Summary = {
  range: Range;
  from: number;
  to: number;
  tz: string;
  /** Every model ever seen, busiest first, for the filter and stable colours; `priced` says a cost can be estimated. */
  models: { model: string; turns: number; priced: boolean }[];
  selected: string[];
  /** Every machine with rows; `local` is the one this service runs on and is named by the caller. */
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

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function validTz(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string): { y: number; m: number; d: number; h: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(ts)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! === 24 ? 0 : p.hour! };
}

/** `YYYY-MM-DD` of an instant in the zone. */
export function dayKey(ts: number, tz: string): string {
  const { y, m, d } = parts(ts, tz);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function hourOf(ts: number, tz: string): number {
  return parts(ts, tz).h;
}

/** The instant the zone's day containing `ts` began. */
export function startOfDay(ts: number, tz: string): number {
  const { y, m, d } = parts(ts, tz);
  const wall = Date.UTC(y, m - 1, d);
  // The zone's offset at that wall time: the same wall time read back from a UTC guess.
  const guess = parts(wall, tz);
  const guessWall = Date.UTC(guess.y, guess.m - 1, guess.d, guess.h);
  return wall - (guessWall - wall);
}

export function windowFor(range: Range, now: number, tz: string): { from: number; to: number } {
  const to = now + 1;
  switch (range) {
    case "5h":
      return { from: now - 5 * HOUR, to };
    case "today":
      return { from: startOfDay(now, tz), to };
    case "7d":
      return { from: startOfDay(now, tz) - 6 * DAY, to };
    case "30d":
      return { from: startOfDay(now, tz) - 29 * DAY, to };
    case "90d":
      return { from: startOfDay(now, tz) - 89 * DAY, to };
    case "all":
      return { from: 0, to };
  }
}

const zero = (): Totals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 });

function add(t: Totals, r: TurnRow, cost: number | null): void {
  t.turns++;
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cache_read;
  t.cacheWrite += r.cache_write;
  t.tokens += r.input + r.output + r.cache_read + r.cache_write;
  if (cost === null) t.cost = null;
  else if (t.cost !== null) t.cost += cost;
}

/** Groups: null cost once any member is unpriced; nothing counted yet is 0. */
function group<K extends string>(): { get: (k: K) => Totals; entries: () => [K, Totals][] } {
  const m = new Map<K, Totals>();
  return {
    get: (k) => {
      let v = m.get(k);
      if (!v) {
        v = zero();
        m.set(k, v);
      }
      return v;
    },
    entries: () => [...m.entries()],
  };
}

export type SummaryOptions = {
  range: Range;
  models?: string[];
  /** Machine names as the store labels them ('' = this machine). */
  machines?: string[];
  tz?: string;
  now?: number;
  sessionLimit?: number;
};

export function summary(store: Store, opts: SummaryOptions): Summary {
  const now = opts.now ?? Date.now();
  const tz = validTz(opts.tz);
  const { from, to } = windowFor(opts.range, now, tz);
  const allModels = store.models().map((m) => ({ ...m, priced: priceFor(m.model) !== null }));
  const selected = (opts.models ?? []).filter((m) => allModels.some((a) => a.model === m));
  const pick = selected.length ? new Set(selected) : null;
  const allMachines = store.machines().map((m) => ({ ...m, local: m.machine === "" }));
  const selectedMachines = (opts.machines ?? []).filter((m) => allMachines.some((a) => a.machine === m));
  const pickMachine = selectedMachines.length ? new Set(selectedMachines) : null;

  const rows = store.turnsBetween(from, to).filter((r) => (!pick || pick.has(r.model)) && (!pickMachine || pickMachine.has(r.machine)));
  const sessionMeta = new Map(store.sessionsSince(from).map((s) => [s.session_id, s]));
  const agentType = new Map(store.agents().map((a) => [a.agent_id, a]));
  const costs = rows.map((r) => costOf(r.model, { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, serviceTier: r.service_tier }));

  const totals = { ...zero(), sessions: 0, days: 0, subagentTokens: 0, subagentTurns: 0, perDay: { tokens: 0, cost: 0 as number | null } };
  const byDay = new Map<string, { tokens: number; cost: number | null; byModel: Record<string, number> }>();
  const byHour = Array.from({ length: 24 }, () => ({ tokens: 0, cost: 0 as number | null }));
  const daysSeen = new Set<string>();
  const byModel = group<string>();
  const byMachine = group<string>();
  const machineSessions = new Map<string, Set<string>>();
  const byProject = group<string>();
  const projectSessions = new Map<string, Set<string>>();
  const byBranch = group<string>();
  const branchSessions = new Map<string, Set<string>>();
  const bySession = group<string>();
  const sessionModels = new Map<string, Map<string, number>>();
  const sessionMachine = new Map<string, string>();
  const sessionSub = new Map<string, number>();
  const byType = group<string>();
  const typeDispatches = new Map<string, Set<string>>();
  const dispatchTokens = new Map<string, Totals>();
  const dispatchSession = new Map<string, string>();

  rows.forEach((r, i) => {
    const cost = costs[i] ?? null;
    const tokens = r.input + r.output + r.cache_read + r.cache_write;
    add(totals, r, cost);
    const day = dayKey(r.ts, tz);
    daysSeen.add(day);
    let d = byDay.get(day);
    if (!d) {
      d = { tokens: 0, cost: 0, byModel: {} };
      byDay.set(day, d);
    }
    d.tokens += tokens;
    d.cost = cost === null ? null : d.cost === null ? null : d.cost + cost;
    d.byModel[r.model] = (d.byModel[r.model] ?? 0) + tokens;
    const h = byHour[hourOf(r.ts, tz)]!;
    h.tokens += tokens;
    h.cost = cost === null ? null : h.cost === null ? null : h.cost + cost;
    add(byModel.get(r.model), r, cost);

    const s = sessionMeta.get(r.session_id);
    const project = s?.project ?? "unknown";
    const branch = s?.branch ?? "";
    add(byMachine.get(r.machine), r, cost);
    (machineSessions.get(r.machine) ?? machineSessions.set(r.machine, new Set()).get(r.machine)!).add(r.session_id);
    const pk = `${r.machine}\u0000${project}`;
    add(byProject.get(pk), r, cost);
    (projectSessions.get(pk) ?? projectSessions.set(pk, new Set()).get(pk)!).add(r.session_id);
    const bk = `${r.machine}\u0000${project}\u0000${branch}`;
    add(byBranch.get(bk), r, cost);
    (branchSessions.get(bk) ?? branchSessions.set(bk, new Set()).get(bk)!).add(r.session_id);
    add(bySession.get(r.session_id), r, cost);
    if (!sessionMachine.has(r.session_id)) sessionMachine.set(r.session_id, r.machine);
    const sm = sessionModels.get(r.session_id) ?? sessionModels.set(r.session_id, new Map()).get(r.session_id)!;
    sm.set(r.model, (sm.get(r.model) ?? 0) + tokens);

    if (r.subagent) {
      totals.subagentTokens += tokens;
      totals.subagentTurns++;
      sessionSub.set(r.session_id, (sessionSub.get(r.session_id) ?? 0) + tokens);
      const type = (r.agent_id && agentType.get(r.agent_id)?.agent_type) || "subagent";
      add(byType.get(type), r, cost);
      if (r.agent_id) {
        (typeDispatches.get(type) ?? typeDispatches.set(type, new Set()).get(type)!).add(r.agent_id);
        add(dispatchTokens.get(r.agent_id) ?? dispatchTokens.set(r.agent_id, zero()).get(r.agent_id)!, r, cost);
        if (!dispatchSession.has(r.agent_id)) dispatchSession.set(r.agent_id, r.session_id);
      }
    }
  });

  totals.sessions = bySession.entries().length;
  totals.days = daysSeen.size;
  // Calendar days the window spans so far: a quiet day counts against the average.
  const firstDay = opts.range === "all" ? (rows[0] ? startOfDay(rows[0].ts, tz) : startOfDay(now, tz)) : Math.max(from, startOfDay(from, tz));
  const spanDays = opts.range === "5h" ? 1 : Math.max(1, Math.round((startOfDay(now, tz) - startOfDay(firstDay, tz)) / DAY) + 1);
  totals.perDay = { tokens: Math.round(totals.tokens / spanDays), cost: totals.cost === null ? null : totals.cost / spanDays };

  const daily: Summary["daily"] = [];
  if (opts.range === "5h") {
    for (const [day, d] of byDay) daily.push({ day, ...d });
  } else {
    for (let t = startOfDay(firstDay, tz); t <= now; t = startOfDay(t + DAY + HOUR, tz)) {
      const day = dayKey(t, tz);
      const d = byDay.get(day);
      daily.push(d ? { day, ...d } : { day, tokens: 0, cost: 0, byModel: {} });
    }
  }

  const sortTokens = <T extends Totals>(a: T, b: T) => b.tokens - a.tokens;
  const sessions: Summary["sessions"] = bySession
    .entries()
    .map(([id, t]) => {
      const s = sessionMeta.get(id);
      const models = [...(sessionModels.get(id) ?? [])];
      const model = models.sort((a, b) => modelRank(b[0]) - modelRank(a[0]) || b[1] - a[1])[0]?.[0] ?? "";
      const first = s?.first_ts || 0;
      const last = s?.last_ts || 0;
      return {
        sessionId: id,
        machine: sessionMachine.get(id) ?? s?.machine ?? "",
        project: s?.project ?? "unknown",
        branch: s?.branch ?? "",
        topic: s?.topic ?? null,
        model,
        first,
        last,
        durationMin: first && last ? Math.max(0, Math.round((last - first) / 60_000)) : 0,
        subagentTokens: sessionSub.get(id) ?? 0,
        ...t,
      };
    })
    .sort((a, b) => b.last - a.last)
    .slice(0, opts.sessionLimit ?? 200);

  const dispatches: Summary["dispatches"] = [...dispatchTokens.entries()]
    .map(([agentId, t]) => {
      const a = agentType.get(agentId);
      const sid = a?.session_id ?? dispatchSession.get(agentId) ?? "";
      return {
        agentId,
        type: a?.agent_type ?? "subagent",
        sessionId: sid,
        machine: sessionMachine.get(sid) ?? a?.machine ?? "",
        project: sessionMeta.get(sid)?.project ?? "unknown",
        completedAt: a?.completed_at ?? 0,
        status: a?.status ?? null,
        tokens: t.tokens,
        cost: t.cost,
        durationMs: a?.duration_ms ?? null,
        toolUses: a?.tool_uses ?? null,
      };
    })
    .sort((a, b) => b.completedAt - a.completedAt || b.tokens - a.tokens)
    .slice(0, 50);

  return {
    range: opts.range,
    from,
    to,
    tz,
    models: allModels,
    selected,
    machines: allMachines,
    selectedMachines,
    totals,
    daily,
    hourly: byHour.map((h, hour) => ({ hour, ...h, avgTokens: Math.round(h.tokens / Math.max(1, daysSeen.size)) })),
    hourlyDays: daysSeen.size,
    byModel: byModel
      .entries()
      .map(([model, t]) => ({ model, ...t }))
      .sort(sortTokens),
    byMachine: byMachine
      .entries()
      .map(([machine, t]) => ({ machine, sessions: machineSessions.get(machine)?.size ?? 0, ...t }))
      .sort(sortTokens),
    byProject: byProject
      .entries()
      .map(([k, t]) => {
        const [machine, project] = k.split("\u0000") as [string, string];
        return { machine, project, sessions: projectSessions.get(k)?.size ?? 0, ...t };
      })
      .sort(sortTokens),
    byBranch: byBranch
      .entries()
      .map(([k, t]) => {
        const [machine, project, branch] = k.split("\u0000") as [string, string, string];
        return { machine, project, branch, sessions: branchSessions.get(k)?.size ?? 0, ...t };
      })
      .sort(sortTokens),
    sessions,
    subagents: byType
      .entries()
      .map(([type, t]) => ({ type, dispatches: typeDispatches.get(type)?.size ?? 0, ...t }))
      .sort(sortTokens),
    dispatches,
  };
}
