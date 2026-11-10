import { type CSSProperties, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type LimitsReply, type LimitsSnapshot, type Status, type Summary, type Totals, dateTime, fmtCost, fmtCostFloor, fmtInt, fmtMinutes, fmtTokens, getJson, planName, postJson, relTime, shortDay } from "./api.ts";
import { HBars, HourBars, Legend, SLOTS, type StackDay, StackedBars, Tooltip, type Tip, seriesVar } from "./charts.tsx";
import { type Key, LANG_KEY, LOCALE, type Lang, detectLang, translate } from "./i18n.ts";

/**
 * The dashboard, on the Space Tiles kit (web/kit.css, ai-space docs/ui-kit.md): a left column with
 * the filters (a drawer below 960 px, `body.sp-open-nav`) and the work column. State that a link
 * should carry (range, models, machines) lives in the URL; which cards are collapsed, the language
 * and the theme live in localStorage. The summary is re-read every 60 s while the tab is visible.
 */

const RANGES = ["5h", "today", "7d", "30d", "90d", "all"] as const;
type Range = (typeof RANGES)[number];
const REFRESH_MS = 60_000;
const THEME_KEY = "ai-usage.theme";
type T = (k: Key, v?: Record<string, string | number>) => string;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private window */
    }
  },
};

/** `claude-haiku-4-5-20251001` -> `haiku 4.5`; DeepSeek ids get their catalogue name; the page's copy of the server's helper. */
const shortModel = (model: string): string => {
  if (model === "deepseek-v4-pro") return "DeepSeek V4 Pro";
  if (model === "deepseek-flash" || model === "deepseek-v4-flash") return "DeepSeek Flash";
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model;
};

function readParams(): { range: Range; models: string[]; machines: string[] } {
  const p = new URLSearchParams(location.search);
  const range = p.get("range") as Range;
  const list = (k: string) => (p.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { range: RANGES.includes(range) ? range : "7d", models: list("models"), machines: list("machines") };
}

function writeParams(range: Range, models: string[], machines: string[], lang: Lang): void {
  const p = new URLSearchParams(location.search);
  p.set("range", range);
  if (models.length) p.set("models", models.join(","));
  else p.delete("models");
  if (machines.length) p.set("machines", machines.join(","));
  else p.delete("machines");
  if (p.has("lang")) p.set("lang", lang);
  history.replaceState(null, "", `?${p}`);
}

function useCollapsed(): [Set<string>, (k: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(store.get("usage-collapsed") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (k: string) =>
    setSet((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      store.set("usage-collapsed", JSON.stringify([...n]));
      return n;
    });
  return [set, toggle];
}

// ---------------------------------------------------------------- icons

const PATHS = {
  bars: "M5 19v-6M12 19V5M19 19v-9",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5",
  refresh: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  menu: "M4 7h16M4 12h16M4 17h16",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevron: "M6 9l6 6 6-6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  auto: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
  alert: "M12 8v5M12 16.5v.01M10.3 4.1L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0z",
  inbox: "M4 13l2.5-7h11L20 13M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
};
function Icon({ name, className = "" }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg className={`ic ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
      {name === "auto" && <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />}
    </svg>
  );
}

// ---------------------------------------------------------------- tiles and tables

const CardCtx = createContext<{ collapsed: Set<string>; toggle: (k: string) => void; t: T }>({ collapsed: new Set(), toggle: () => {}, t: (k) => k });

function Card({ id, title, hint, right, className = "", children }: { id: string; title: string; hint?: string; right?: ReactNode; className?: string; children: ReactNode }) {
  const { collapsed, toggle, t } = useContext(CardCtx);
  const closed = collapsed.has(id);
  return (
    <section className={`sp-tile card${closed ? " closed" : ""} ${className}`} id={id} aria-labelledby={`${id}-t`}>
      <div className="card-head">
        <h2 className="sp-tt" id={`${id}-t`}>
          <span className="sp-sq" aria-hidden="true" />
          {title}
        </h2>
        {hint && <span className="hint">{hint}</span>}
        <span className="spacer" />
        {!closed && right}
        <button type="button" className="sp-icon-btn caret" onClick={() => toggle(id)} aria-expanded={!closed} aria-controls={`${id}-b`} aria-label={closed ? t("expand") : t("collapse")} title={closed ? t("expand") : t("collapse")}>
          <Icon name="chevron" />
        </button>
      </div>
      {!closed && (
        <div className="card-body" id={`${id}-b`}>
          {children}
        </div>
      )}
    </section>
  );
}

type SortDir = "desc" | "asc";
function useSort<K extends string>(initial: K): [K, SortDir, (k: K) => void] {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>("desc");
  const set = (k: K) => {
    if (k === key) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setKey(k);
      setDir("desc");
    }
  };
  return [key, dir, set];
}

function sortRows<T>(rows: T[], key: keyof T, dir: SortDir): T[] {
  const s = [...rows].sort((a, b) => {
    const x = a[key] as unknown;
    const y = b[key] as unknown;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  });
  return dir === "desc" ? s.reverse() : s;
}

function Th<K extends string>({ k, label, sortKey, dir, onSort, left }: { k: K; label: string; sortKey: K; dir: SortDir; onSort: (k: K) => void; left?: boolean }) {
  const on = k === sortKey;
  return (
    <th className={`sortable${left ? " l" : ""}`} aria-sort={on ? (dir === "desc" ? "descending" : "ascending") : undefined} scope="col">
      <button type="button" className="sort" onClick={() => onSort(k)}>
        {label}
        {on ? (dir === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
}

function Rows<R>({ rows, limit, render, t, q, cols }: { rows: R[]; limit: number; render: (r: R, i: number) => ReactNode; t: T; q?: string; cols: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, limit);
  return (
    <>
      <tbody>
        {shown.map(render)}
        {!rows.length && q && (
          <tr className="no-match">
            <td colSpan={cols}>{t("noMatch", { q })}</td>
          </tr>
        )}
      </tbody>
      {rows.length > limit && (
        <tfoot>
          <tr>
            <td colSpan={cols} className="l bare">
              <button type="button" className="more" onClick={() => setOpen(!open)}>
                {open ? t("showLess") : t("showMore", { n: rows.length - limit })}
              </button>
            </td>
          </tr>
        </tfoot>
      )}
    </>
  );
}

const TokenCells = ({ r, lang, t }: { r: Totals; lang: Lang; t: T }) => (
  <>
    <td data-label={t("col.turns")}>{fmtInt(r.turns, lang)}</td>
    <td data-label={t("col.input")}>{fmtTokens(r.input)}</td>
    <td data-label={t("col.output")}>{fmtTokens(r.output)}</td>
    <td data-label={t("col.cacheRead")}>{fmtTokens(r.cacheRead)}</td>
    <td data-label={t("col.cacheWrite")}>{fmtTokens(r.cacheWrite)}</td>
    <td data-label={t("col.tokens")}>{fmtTokens(r.tokens)}</td>
    <td data-label={t("col.cost")}>{fmtCost(r.cost, lang)}</td>
  </>
);

const Meter = ({ v, color, className = "" }: { v: number; color?: string; className?: string }) => (
  <span className={`sp-meter ${className}`} style={{ "--v": `${Math.max(0, Math.min(100, v))}%` } as CSSProperties}>
    <i style={color ? { background: color } : undefined} />
  </span>
);

/** The /usage meters: one block per account (the newest reading), session first, then the weekly ones. */
function LimitsCard({ snaps, lang, t }: { snaps: LimitsSnapshot[]; lang: Lang; t: T }) {
  const now = Date.now();
  const resets = (at: number | null): string => {
    if (at === null) return "";
    if (at <= now) return t("resetDone");
    const min = Math.round((at - now) / 60_000);
    if (min < 24 * 60) return t("resetsIn", { in: fmtMinutes(min, lang) });
    return t("resetsAt", { at: new Date(at).toLocaleString(LOCALE[lang], { weekday: "short", hour: "numeric", minute: "2-digit" }) });
  };
  return (
    <Card id="limits" title={t("limits")}>
      {!snaps.length && <p className="note">{t("limitsNone")}</p>}
      {snaps.map((s) => {
        const rows = [...s.limits.filter((l) => l.group === "session"), ...s.limits.filter((l) => l.group !== "session")];
        return (
          <div key={`${s.provider ?? "claude"}/${s.account ?? s.machine}`} className="lim">
            <div className="lim-head" title={t("limitsHint", { machine: s.machine })}>
              <b>{t(s.provider === "codex" ? "provider.codex" : "provider.claude")}</b>
              {[planName(s.plan, s.tier), t("limitsFrom", { machine: s.machine, ago: relTime(s.fetchedAt, lang) })].filter(Boolean).join(" · ")}
            </div>
            <div className="meters">
              {rows.map((l) => {
                const pct = Math.round(l.resetsAt !== null && l.resetsAt <= now ? 0 : Math.min(100, Math.max(0, l.percent)));
                const level = l.severity === "critical" || pct >= 95 ? "bad" : l.severity === "warning" || pct >= 80 ? "warn" : "";
                const name = l.group === "session" ? (l.label ?? t("limit.session")) : `${t("limit.weekly")} · ${l.label ?? t("limit.weekly_all")}`;
                return (
                  <div key={`${l.kind}/${l.label ?? ""}`} className={`meter ${level}`}>
                    <div className="m-top">
                      <span>{name}</span>
                      <span className="m-val">
                        {level && <span className="lvl">{t(level === "bad" ? "limit.bad" : "limit.warn")}</span>}
                        {t("used", { pct })}
                      </span>
                    </div>
                    <Meter v={pct} className={level} />
                    <span className="m-sub" title={l.resetsAt ? dateTime(l.resetsAt, lang) : ""}>
                      {resets(l.resetsAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/** `2026-11-03` -> `Nov 3` / `11月3日` (with the year when asked). */
const dayText = (day: string, lang: Lang, year = false): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(LOCALE[lang], { year: year ? "numeric" : undefined, month: "short", day: "numeric", timeZone: "UTC" });
};

/** The viewer's today as `YYYY-MM-DD` in the zone the page sends. */
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export default function App() {
  const [lang, setLangState] = useState<Lang>(() => (document.documentElement.lang ? (document.documentElement.lang.startsWith("zh") ? "zh" : "en") : detectLang()));
  const [mode, setMode] = useState<string>(() => document.documentElement.dataset.mode ?? "system");
  const t = useCallback<T>((k, v) => translate(lang, k, v), [lang]);
  const [{ range, models, machines }, setParams] = useState(readParams);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [limits, setLimits] = useState<LimitsSnapshot[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<Tip>(null);
  const [q, setQ] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, toggleCard] = useCollapsed();
  const searchRef = useRef<HTMLInputElement>(null);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(() => {
    const p = new URLSearchParams({ range, tz });
    if (models.length) p.set("models", models.join(","));
    if (machines.length) p.set("machines", machines.join(","));
    return Promise.all([getJson<Summary>(`/api/summary?${p}`), getJson<Status>("/api/status"), getJson<LimitsReply>("/api/limits").catch(() => null)])
      .then(([s, st, lim]) => {
        setSummary(s);
        setStatus(st);
        if (lim) setLimits(lim.snapshots);
        setErr("");
      })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [range, models, machines, tz]);

  useEffect(() => {
    writeParams(range, models, machines, lang);
    load();
    const timer = setInterval(() => !document.hidden && load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, range, models, machines, lang]);

  useEffect(() => {
    document.title = t("title");
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [t, lang]);

  // The left column is a drawer below 960 px: classes on body (docs/ui-kit.md); Escape and a wide window close it.
  useEffect(() => {
    document.body.classList.toggle("sp-open-nav", navOpen);
    document.body.classList.toggle("sp-sheet-open", navOpen);
  }, [navOpen]);
  useEffect(() => {
    const mq = matchMedia("(min-width: 960px)");
    const onWide = (e: MediaQueryListEvent) => e.matches && setNavOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
      if (e.key === "/" && !(e.target as HTMLElement).closest?.("input, textarea, select")) {
        e.preventDefault();
        if (!mq.matches) setNavOpen(true);
        searchRef.current?.focus();
      }
    };
    mq.addEventListener("change", onWide);
    document.addEventListener("keydown", onKey);
    return () => {
      mq.removeEventListener("change", onWide);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const setLang = (l: Lang) => {
    store.set(LANG_KEY, l);
    setLangState(l);
  };
  const cycleTheme = () => {
    const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
    const root = document.documentElement;
    root.dataset.mode = next;
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    store.set(THEME_KEY, next === "system" ? null : next);
    setMode(next);
  };
  const themeLabel = t(mode === "light" ? "themeLight" : mode === "dark" ? "themeDark" : "themeSystem");

  const refresh = () => {
    setBusy(true);
    postJson("/api/refresh")
      .then(load)
      .catch((e) => setErr(String((e as Error).message || e)))
      .finally(() => setBusy(false));
  };

  // Colour slots follow the model's place in the all-time list, so a filter never repaints a survivor.
  const slotOf = useMemo(() => {
    const order = new Map((summary?.models ?? []).map((m, i) => [m.model, i]));
    return (model: string) => order.get(model) ?? SLOTS;
  }, [summary?.models]);
  const colorOf = (model: string) => seriesVar(slotOf(model));
  const modelLabel = (m: string) => shortModel(m);

  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const setRange = (r: Range) => {
    setParams((p) => ({ ...p, range: r }));
    setNavOpen(false);
  };
  // Models are checkboxes: no filter = every box checked. Unchecking one from "all" keeps the others;
  // checking the last unchecked one goes back to no filter. The last checked box cannot be unchecked.
  const toggleModel = (m: string) =>
    setParams((p) => {
      const all = (summary?.models ?? []).map((x) => x.model);
      const cur = p.models.length ? p.models : all;
      const next = toggleIn(cur, m);
      if (!next.length) return p;
      return { ...p, models: all.every((x) => next.includes(x)) ? [] : next };
    });
  const toggleMachine = (m: string) => setParams((p) => ({ ...p, machines: toggleIn(p.machines, m) }));

  const tot = summary?.totals;
  const multiMachine = (summary?.machines.length ?? 0) > 1;
  const today = useMemo(() => todayIn(tz), [tz, summary]);

  // The search narrows the project, branch, session and dispatch views; it is not part of the link.
  const ql = q.trim().toLowerCase();
  const hit = (...xs: (string | null | undefined)[]) => !ql || xs.some((x) => x?.toLowerCase().includes(ql));

  // The daily stack: the models present in the window, busiest first; past eight slots they fold into "other".
  const stackDays: StackDay[] = useMemo(() => {
    if (!summary) return [];
    const present = summary.byModel.map((m) => m.model);
    return summary.daily.map((d) => {
      const parts: { series: string; value: number }[] = [];
      let other = 0;
      for (const m of present) {
        const v = d.byModel[m] ?? 0;
        if (!v) continue;
        if (slotOf(m) < SLOTS) parts.push({ series: m, value: v });
        else other += v;
      }
      if (other) parts.push({ series: "__other", value: other });
      return { key: d.day, label: shortDay(d.day, lang), total: d.tokens, parts };
    });
  }, [summary, slotOf, lang]);
  const stackSlot = (s: string) => (s === "__other" ? SLOTS : slotOf(s));
  const legend = useMemo(() => {
    if (!summary) return [];
    const items = summary.byModel.filter((m) => slotOf(m.model) < SLOTS).map((m) => ({ key: m.model, label: modelLabel(m.model), slot: slotOf(m.model), value: fmtTokens(m.tokens) }));
    const rest = summary.byModel.filter((m) => slotOf(m.model) >= SLOTS).reduce((a, m) => a + m.tokens, 0);
    if (rest) items.push({ key: "__other", label: t("other"), slot: SLOTS, value: fmtTokens(rest) });
    return items;
  }, [summary, slotOf, t]);

  const [mSort, mDir, setMSort] = useSort<"model" | "turns" | "input" | "output" | "cacheRead" | "cacheWrite" | "tokens" | "cost">("tokens");
  const [sSort, sDir, setSSort] = useSort<"last" | "durationMin" | "turns" | "tokens" | "cost" | "project">("last");
  const [pSort, pDir, setPSort] = useSort<"project" | "sessions" | "turns" | "tokens" | "cost">("tokens");
  const [bSort, bDir, setBSort] = useSort<"project" | "branch" | "sessions" | "turns" | "tokens" | "cost">("tokens");

  const sumCost = (rows: Totals[]) => rows.reduce<number | null>((a, r) => (a === null || r.cost === null ? null : a + r.cost), 0);

  // The heading: the window in words, its dates, the zone.
  const span = useMemo(() => {
    if (!summary) return "";
    if (range === "5h") {
      const tm = (ts: number) => new Date(ts).toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit" });
      return `${tm(summary.from)} – ${tm(summary.to)}`;
    }
    const first = summary.daily[0]?.day;
    const last = summary.daily[summary.daily.length - 1]?.day;
    if (!first || !last) return "";
    const year = range === "all" || first.slice(0, 4) !== last.slice(0, 4);
    return first === last ? dayText(first, lang, year) : `${dayText(first, lang, year)} – ${dayText(last, lang, year)}`;
  }, [summary, range, lang]);

  const ctx = useMemo(() => ({ collapsed, toggle: toggleCard, t }), [collapsed, toggleCard, t]);
  const projects = summary ? summary.byProject.filter((p) => hit(p.project, p.machine)) : [];
  const branches = summary ? summary.byBranch.filter((b) => hit(b.project, b.branch, b.machine)) : [];
  const sessions = summary ? summary.sessions.filter((s) => hit(s.project, s.topic, s.branch, s.machine, s.model, shortModel(s.model))) : [];
  const dispatches = summary ? summary.dispatches.filter((d) => hit(d.project, d.type, d.machine, d.status)) : [];
  const subagentRows = summary ? summary.subagents.map((s) => ({ key: s.type, label: s.type, value: s.tokens, title: `${s.dispatches} · ${fmtCost(s.cost, lang)}` })) : [];
  const machineChip = (m: string) => (multiMachine ? <span className="tag">{m}</span> : null);

  return (
    <CardCtx.Provider value={ctx}>
      <div className="sp-app">
        <nav className="sp-tile sp-side" id="side" aria-label={t("navAria")}>
          <div className="sp-brand">
            <span className="sp-logo sp-logo-img" aria-hidden="true">
              <img src="/icon.png" alt="" width={32} height={32} />
            </span>
            <span className="sp-brand-txt">
              <strong>{t("title")}</strong>
              <span className="sp-brand-sub" lang={lang === "zh" ? "en" : "zh-CN"}>
                {t("brandAlt")}
              </span>
            </span>
            <button type="button" className="sp-icon-btn sp-side-close" onClick={() => setNavOpen(false)} aria-label={t("navClose")}>
              <Icon name="x" />
            </button>
          </div>
          <div className="sp-search side-search" role="search">
            <Icon name="search" />
            <label className="sp-sr" htmlFor="q">
              {t("search")}
            </label>
            <input id="q" ref={searchRef} type="search" placeholder={t("searchPh")} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
            {!q && (
              <span className="sp-kbd" aria-hidden="true">
                /
              </span>
            )}
          </div>
          <div className="sp-side-scroll">
            <div className="sp-ngroup">
              <div className="sp-nlabel" id="g-range">
                {t("range")}
              </div>
              <div className="sp-seg in-tile range-seg" role="group" aria-labelledby="g-range">
                {RANGES.map((r) => (
                  <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
                    {t(`range.${r}` as Key)}
                  </button>
                ))}
              </div>
            </div>
            {multiMachine && summary && (
              <div className="sp-ngroup">
                <div className="sp-nlabel" id="g-machines">
                  {t("machines")}
                </div>
                <ul aria-labelledby="g-machines">
                  <li>
                    <button type="button" className="sp-nitem" aria-pressed={!machines.length} onClick={() => setParams((p) => ({ ...p, machines: [] }))}>
                      <span className="nm">{t("all")}</span>
                    </button>
                  </li>
                  {summary.machines.map((m) => (
                    <li key={m.machine}>
                      <button type="button" className="sp-nitem" aria-pressed={machines.includes(m.machine)} onClick={() => toggleMachine(m.machine)}>
                        <span className="nm">{m.machine}</span>
                        {m.local && <span className="sp-nc">{t("thisMachine")}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary && summary.models.length > 0 && (
              <div className="sp-ngroup">
                <div className="sp-nlabel with-act" id="g-models">
                  <span>{t("models")}</span>
                  {models.length > 0 && (
                    <button type="button" className="reset" onClick={() => setParams((p) => ({ ...p, models: [] }))}>
                      {t("all")}
                    </button>
                  )}
                </div>
                <ul aria-labelledby="g-models">
                  {summary.models.map((m) => {
                    const on = !models.length || models.includes(m.model);
                    const last = on && (models.length === 1 || summary.models.length === 1);
                    return (
                      <li key={m.model}>
                        <label className={on ? "mcheck" : "mcheck off"} title={`${m.model} · ${fmtInt(m.turns, lang)} ${t("turns").toLowerCase()}`}>
                          <span className="sp-check">
                            <input type="checkbox" checked={on} disabled={last} onChange={() => toggleModel(m.model)} />
                            <span>
                              <Icon name="check" />
                            </span>
                          </span>
                          <i className="sw" style={{ background: colorOf(m.model) }} aria-hidden="true" />
                          <span className="nm">{modelLabel(m.model)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          <div className="sp-side-foot">
            <div className="sp-seg sm" role="group" aria-label={t("langAria")}>
              <button type="button" lang="zh-CN" aria-pressed={lang === "zh"} onClick={() => setLang("zh")}>
                中
              </button>
              <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
                EN
              </button>
            </div>
            <button type="button" className="sp-icon-btn" onClick={cycleTheme} aria-label={themeLabel} title={themeLabel}>
              <Icon name={mode === "light" ? "sun" : mode === "dark" ? "moon" : "auto"} />
            </button>
          </div>
        </nav>

        <div className="sp-work">
          <main className="sp-center">
            <div className="sp-mbar">
              <button type="button" className="sp-icon-btn" onClick={() => setNavOpen(true)} aria-label={t("navOpen")} aria-controls="side" aria-expanded={navOpen}>
                <Icon name="menu" />
              </button>
              <strong>{t("title")}</strong>
              <button type="button" className={`sp-icon-btn${busy ? " spin" : ""}`} onClick={refresh} disabled={busy} aria-label={busy ? t("refreshing") : t("refresh")} title={busy ? t("refreshing") : t("refresh")}>
                <Icon name="refresh" />
              </button>
            </div>

            <header className="sp-head">
              <div className="head-title">
                <h1>{t(`head.${range}` as Key)}</h1>
                <div className="head-sub">
                  {span && <span>{span}</span>}
                  <span>{summary?.tz ?? tz}</span>
                </div>
                {status && (
                  <div className="head-status">
                    <span title={status.sources.join("\n")}>
                      {status.machine} · {t("files", { n: status.files })}
                    </span>
                    {status.shared && (
                      <span title={`${status.shared.url}\n${t("sharedHint")}`}>{t("shared", { ago: status.shared.lastSyncAt ? relTime(status.shared.lastSyncAt, lang) : t("never") })}</span>
                    )}
                    {(status.shared?.machines ?? []).map((m) => (
                      <span key={m.name} className="peer" title={m.ok ? t("machineOk", { name: m.name, ago: m.updatedAt ? relTime(m.updatedAt, lang) : t("never") }) : t("peerDown", { name: m.name, error: m.error ?? "" })}>
                        <i className={`sp-dot ${m.ok ? "ok" : "bad"}`} />
                        {m.name}
                      </span>
                    ))}
                    {status.peers.map((p) => (
                      <span key={p.name} className="peer" title={p.ok ? t("peerOk", { name: p.name, ago: p.lastPullAt ? relTime(p.lastPullAt, lang) : t("never") }) : t("peerDown", { name: p.name, error: p.error ?? "" })}>
                        <i className={`sp-dot ${p.ok ? "ok" : "bad"}`} />
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="sp-head-actions">
                {status && <span className="scanned">{status.lastScan ? t("lastScan", { ago: relTime(status.lastScan, lang) }) : t("never")}</span>}
                <button type="button" className={`sp-btn outline head-refresh${busy ? " spin" : ""}`} onClick={refresh} disabled={busy}>
                  <Icon name="refresh" />
                  {busy ? t("refreshing") : t("refresh")}
                </button>
              </div>
            </header>

            {err && (
              <div className="sp-banner bad" role="alert">
                <Icon name="alert" />
                <span className="grow">{t("unavailable", { error: err })}</span>
                <button type="button" className="sp-btn sm" onClick={() => load()}>
                  {t("retry")}
                </button>
              </div>
            )}

            {!summary && !err && (
              <div className="board" aria-busy="true" aria-label={t("loading")}>
                <div className="sk-figs">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i}>
                      <span className="sp-sk" style={{ width: "40%" }} />
                      <span className="sp-sk fig" />
                    </div>
                  ))}
                </div>
                <div className="sp-tile pad sk-tile span-8">
                  <span className="sp-sk" style={{ width: "30%" }} />
                  <span className="sp-sk plot" />
                </div>
                <div className="sp-tile pad sk-tile span-4">
                  <span className="sp-sk" style={{ width: "40%" }} />
                  <span className="sp-sk plot" />
                </div>
              </div>
            )}

            {summary && status && status.turns === 0 && (
              <section className="sp-tile state-tile">
                <div className="sp-state">
                  <span className="ico">
                    <Icon name="inbox" />
                  </span>
                  <p>{t("noData", { sources: status.sources.join(", ") })}</p>
                </div>
              </section>
            )}

            {limits && <LimitsCard snaps={limits} lang={lang} t={t} />}

            {summary && tot && (
              <>
                <div className="figs">
                  <div className="fig">
                    <span className="sp-unit">{t("tokens")}</span>
                    <span className="sp-fig">{fmtTokens(tot.tokens)}</span>
                    <span className="sp-unit">{tot.subagentTokens ? t("subagentShare", { pct: Math.round((tot.subagentTokens / Math.max(1, tot.tokens)) * 100) }) : " "}</span>
                  </div>
                  <div
                    className="fig cost"
                    title={[t("costHint", { asOf: status?.pricingAsOf ?? "" }), ...(tot.cost === null ? [t("unpricedHint", { models: tot.unpricedModels.join(", "), tokens: fmtTokens(tot.unpricedTokens) })] : [])].join("\n\n")}
                  >
                    <span className="sp-unit">{t("cost")}</span>
                    <span className="sp-fig lg">{fmtCostFloor(tot.cost, tot.pricedCost, lang)}</span>
                    <span className="sp-unit">{tot.cost === null ? t("unpricedCount", { n: tot.unpricedModels.length }) : " "}</span>
                  </div>
                  <div className="fig">
                    <span className="sp-unit">{t("sessions")}</span>
                    <span className="sp-fig">{fmtInt(tot.sessions, lang)}</span>
                    <span className="sp-unit"> </span>
                  </div>
                  <div className="fig">
                    <span className="sp-unit">{t("turns")}</span>
                    <span className="sp-fig">{fmtInt(tot.turns, lang)}</span>
                    <span className="sp-unit"> </span>
                  </div>
                  <div className="fig" title={t("perDayHint", { n: summary.daily.length })}>
                    <span className="sp-unit">{t("perDay")}</span>
                    <span className="sp-fig">{fmtTokens(tot.perDay.tokens)}</span>
                    <span className="sp-unit">{fmtCostFloor(tot.perDay.cost, tot.perDay.pricedCost, lang)}</span>
                  </div>
                </div>

                {tot.turns === 0 && status && status.turns > 0 && (
                  <section className="sp-tile state-tile">
                    <div className="sp-state">
                      <span className="ico">
                        <Icon name="inbox" />
                      </span>
                      <p>{t("empty")}</p>
                    </div>
                  </section>
                )}

                {tot.turns > 0 && (
                  <div className="board">
                    <Card id="daily" title={t("daily")} hint={t("dailyByModel")} className="span-8">
                      <StackedBars
                        days={stackDays}
                        slotOf={stackSlot}
                        fmt={fmtTokens}
                        onTip={setTip}
                        onLeave={() => setTip(null)}
                        today={today}
                        todayLabel={t("range.today")}
                        avg={tot.perDay.tokens}
                        avgLabel={(v) => t("avg", { v })}
                        tipBody={(d) => {
                          const day = summary.daily.find((x) => x.day === d.key);
                          return (
                            <>
                              <b>
                                {d.key}
                                {d.key === today ? ` · ${t("range.today")}` : ""} · {t("tokensOn", { tokens: fmtTokens(d.total), cost: fmtCost(day?.cost ?? null, lang) })}
                              </b>
                              {[...d.parts].reverse().map((p) => (
                                <div key={p.series} className="row">
                                  <span>
                                    <i className="sw" style={{ background: seriesVar(stackSlot(p.series)) }} />
                                    {p.series === "__other" ? t("other") : modelLabel(p.series)}
                                  </span>
                                  <span>{fmtTokens(p.value)}</span>
                                </div>
                              ))}
                            </>
                          );
                        }}
                      />
                      {legend.length > 1 && <Legend items={legend} />}
                    </Card>

                    <Card id="hourly" title={t("hourly")} className="span-4">
                      <HourBars
                        hours={summary.hourly.map((h) => ({ hour: h.hour, value: h.avgTokens }))}
                        fmt={fmtTokens}
                        onTip={setTip}
                        onLeave={() => setTip(null)}
                        label={(h, v) => (
                          <>
                            <b>
                              {String(h).padStart(2, "0")}:00–{String(h + 1).padStart(2, "0")}:00
                            </b>
                            <div className="row">
                              <span>{t("tokens")}</span>
                              <span>{fmtTokens(v)}</span>
                            </div>
                          </>
                        )}
                      />
                      <p className="card-foot">{t("hourlyHint", { n: summary.hourlyDays })}</p>
                    </Card>

                    <Card id="cost-model" title={t("byModel")}>
                      <div className="tbl-wrap">
                        <table className="sp-table data">
                          <thead>
                            <tr>
                              <Th k="model" label={t("col.model")} sortKey={mSort} dir={mDir} onSort={setMSort} left />
                              <Th k="turns" label={t("col.turns")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="input" label={t("col.input")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="output" label={t("col.output")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="cacheRead" label={t("col.cacheRead")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="cacheWrite" label={t("col.cacheWrite")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="tokens" label={t("col.tokens")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <Th k="cost" label={t("col.cost")} sortKey={mSort} dir={mDir} onSort={setMSort} />
                              <th scope="col">{t("col.share")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortRows(summary.byModel, mSort, mDir).map((m) => {
                              const share = Math.round((m.tokens / Math.max(1, tot.tokens)) * 100);
                              return (
                                <tr key={m.model} title={`${m.model} · ${fmtCost(m.cost, lang)}`}>
                                  <td className="l name lead">
                                    <i className="sw" style={{ background: colorOf(m.model) }} />
                                    {m.model}
                                  </td>
                                  <TokenCells r={m} lang={lang} t={t} />
                                  <td data-label={t("col.share")}>
                                    <span className="share">
                                      <Meter v={(m.tokens / Math.max(1, summary.byModel[0]?.tokens ?? 1)) * 100} color={colorOf(m.model)} />
                                      {share}%
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td className="l lead">{t("total")}</td>
                              <TokenCells r={{ ...tot, cost: sumCost(summary.byModel) }} lang={lang} t={t} />
                              <td className="bare" />
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </Card>

                    <Card id="projects" title={t("byProject")} className={multiMachine ? "span-4" : "span-6"}>
                      {projects.length ? (
                        <HBars
                          rows={projects.slice(0, 10).map((p) => ({
                            key: `${p.machine}/${p.project}`,
                            label: (
                              <>
                                {machineChip(p.machine)}
                                {p.project}
                              </>
                            ),
                            value: p.tokens,
                            title: `${fmtCost(p.cost, lang)} · ${p.sessions} ${t("sessions").toLowerCase()}`,
                          }))}
                          fmt={fmtTokens}
                        />
                      ) : (
                        <p className="note">{t("noMatch", { q })}</p>
                      )}
                    </Card>

                    {multiMachine && (
                      <Card id="machines" title={t("byMachine")} className="span-4">
                        <HBars rows={summary.byMachine.map((m) => ({ key: m.machine, label: m.machine, value: m.tokens, title: `${fmtCost(m.cost, lang)} · ${m.sessions} ${t("sessions").toLowerCase()}` }))} fmt={fmtTokens} />
                      </Card>
                    )}
                    <Card id="subagents" title={t("subagents")} className={multiMachine ? "span-4" : "span-6"}>
                      {subagentRows.length ? <HBars rows={subagentRows} fmt={fmtTokens} /> : <p className="note">{t("noSubagents")}</p>}
                    </Card>

                    <Card id="sessions" title={t("sessionsTable")}>
                      <div className="tbl-wrap">
                        <table className="sp-table data">
                          <thead>
                            <tr>
                              <Th k="project" label={t("col.project")} sortKey={sSort} dir={sDir} onSort={setSSort} left />
                              <th className="l" scope="col">
                                {t("col.topic")}
                              </th>
                              <th className="l" scope="col">
                                {t("col.model")}
                              </th>
                              <Th k="last" label={t("col.last")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                              <Th k="durationMin" label={t("col.duration")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                              <Th k="turns" label={t("col.turns")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                              <Th k="tokens" label={t("col.tokens")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                              <Th k="cost" label={t("col.cost")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                            </tr>
                          </thead>
                          <Rows
                            rows={sortRows(sessions, sSort, sDir)}
                            limit={15}
                            t={t}
                            q={q}
                            cols={8}
                            render={(s) => (
                              <tr key={s.sessionId} title={`${s.sessionId}\n${s.branch ? `branch ${s.branch}\n` : ""}${s.subagentTokens ? `${fmtTokens(s.subagentTokens)} tokens by subagents` : ""}`}>
                                <td className="l ell name lead">
                                  {machineChip(s.machine)}
                                  {s.project}
                                </td>
                                <td className="l ell dim wide bare" data-label={t("col.topic")}>
                                  {s.topic ?? ""}
                                </td>
                                <td className="l" data-label={t("col.model")}>
                                  <span>
                                    <i className="sw" style={{ background: colorOf(s.model), marginRight: 6 }} />
                                    {modelLabel(s.model)}
                                  </span>
                                </td>
                                <td data-label={t("col.last")} title={dateTime(s.last, lang)}>
                                  {relTime(s.last, lang)}
                                </td>
                                <td data-label={t("col.duration")}>{fmtMinutes(s.durationMin, lang)}</td>
                                <td data-label={t("col.turns")}>{fmtInt(s.turns, lang)}</td>
                                <td data-label={t("col.tokens")}>{fmtTokens(s.tokens)}</td>
                                <td data-label={t("col.cost")}>{fmtCost(s.cost, lang)}</td>
                              </tr>
                            )}
                          />
                        </table>
                      </div>
                    </Card>

                    {summary.dispatches.length > 0 && (
                      <Card id="dispatches" title={t("dispatches")} hint={fmtInt(summary.dispatches.length, lang)}>
                        <div className="tbl-wrap">
                          <table className="sp-table data">
                            <thead>
                              <tr>
                                <th className="l" scope="col">
                                  {t("col.type")}
                                </th>
                                <th className="l" scope="col">
                                  {t("col.project")}
                                </th>
                                <th className="l" scope="col">
                                  {t("col.status")}
                                </th>
                                <th scope="col">{t("col.completed")}</th>
                                <th scope="col">{t("col.duration")}</th>
                                <th scope="col">{t("col.tools")}</th>
                                <th scope="col">{t("col.tokens")}</th>
                                <th scope="col">{t("col.cost")}</th>
                              </tr>
                            </thead>
                            <Rows
                              rows={dispatches}
                              limit={10}
                              t={t}
                              q={q}
                              cols={8}
                              render={(d) => (
                                <tr key={d.agentId} title={d.agentId}>
                                  <td className="l name lead">{d.type}</td>
                                  <td className="l ell wide" data-label={t("col.project")}>
                                    {machineChip(d.machine)}
                                    {d.project}
                                  </td>
                                  <td className="l dim" data-label={t("col.status")}>
                                    {d.status ?? ""}
                                  </td>
                                  <td data-label={t("col.completed")} title={d.completedAt ? dateTime(d.completedAt, lang) : ""}>
                                    {d.completedAt ? relTime(d.completedAt, lang) : ""}
                                  </td>
                                  <td data-label={t("col.duration")}>{d.durationMs !== null ? fmtMinutes(Math.round(d.durationMs / 60_000), lang) : ""}</td>
                                  <td data-label={t("col.tools")}>{d.toolUses ?? ""}</td>
                                  <td data-label={t("col.tokens")}>{fmtTokens(d.tokens)}</td>
                                  <td data-label={t("col.cost")}>{fmtCost(d.cost, lang)}</td>
                                </tr>
                              )}
                            />
                          </table>
                        </div>
                      </Card>
                    )}

                    <Card id="cost-project" title={t("projectsTable")}>
                      <div className="tbl-wrap">
                        <table className="sp-table data">
                          <thead>
                            <tr>
                              <Th k="project" label={t("col.project")} sortKey={pSort} dir={pDir} onSort={setPSort} left />
                              <Th k="sessions" label={t("col.sessions")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                              <Th k="turns" label={t("col.turns")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                              <Th k="tokens" label={t("col.tokens")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                              <th scope="col">{t("col.share")}</th>
                              <Th k="cost" label={t("col.cost")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                            </tr>
                          </thead>
                          <Rows
                            rows={sortRows(projects, pSort, pDir)}
                            limit={15}
                            t={t}
                            q={q}
                            cols={6}
                            render={(p) => (
                              <tr key={`${p.machine}/${p.project}`}>
                                <td className="l ell name lead">
                                  {machineChip(p.machine)}
                                  {p.project}
                                </td>
                                <td data-label={t("col.sessions")}>{fmtInt(p.sessions, lang)}</td>
                                <td data-label={t("col.turns")}>{fmtInt(p.turns, lang)}</td>
                                <td data-label={t("col.tokens")}>{fmtTokens(p.tokens)}</td>
                                <td className="dim" data-label={t("col.share")}>
                                  {Math.round((p.tokens / Math.max(1, tot.tokens)) * 100)}%
                                </td>
                                <td data-label={t("col.cost")}>{fmtCost(p.cost, lang)}</td>
                              </tr>
                            )}
                          />
                        </table>
                      </div>
                    </Card>

                    <Card id="cost-branch" title={t("branchesTable")}>
                      <div className="tbl-wrap">
                        <table className="sp-table data">
                          <thead>
                            <tr>
                              <Th k="project" label={t("col.project")} sortKey={bSort} dir={bDir} onSort={setBSort} left />
                              <Th k="branch" label={t("col.branch")} sortKey={bSort} dir={bDir} onSort={setBSort} left />
                              <Th k="sessions" label={t("col.sessions")} sortKey={bSort} dir={bDir} onSort={setBSort} />
                              <Th k="turns" label={t("col.turns")} sortKey={bSort} dir={bDir} onSort={setBSort} />
                              <Th k="tokens" label={t("col.tokens")} sortKey={bSort} dir={bDir} onSort={setBSort} />
                              <Th k="cost" label={t("col.cost")} sortKey={bSort} dir={bDir} onSort={setBSort} />
                            </tr>
                          </thead>
                          <Rows
                            rows={sortRows(branches, bSort, bDir)}
                            limit={15}
                            t={t}
                            q={q}
                            cols={6}
                            render={(b) => (
                              <tr key={`${b.machine}/${b.project}/${b.branch}`}>
                                <td className="l ell name lead">
                                  {machineChip(b.machine)}
                                  {b.project}
                                </td>
                                <td className="l dim wide" data-label={t("col.branch")}>
                                  {b.branch || "–"}
                                </td>
                                <td data-label={t("col.sessions")}>{fmtInt(b.sessions, lang)}</td>
                                <td data-label={t("col.turns")}>{fmtInt(b.turns, lang)}</td>
                                <td data-label={t("col.tokens")}>{fmtTokens(b.tokens)}</td>
                                <td data-label={t("col.cost")}>{fmtCost(b.cost, lang)}</td>
                              </tr>
                            )}
                          />
                        </table>
                      </div>
                    </Card>
                  </div>
                )}
              </>
            )}

            <p className="foot">{t("footer", { asOf: status?.pricingAsOf ?? "" })}</p>
          </main>
        </div>
      </div>
      <div className="sp-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <Tooltip tip={tip} />
    </CardCtx.Provider>
  );
}
