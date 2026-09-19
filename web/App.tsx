import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Status, type Summary, type Totals, dateTime, fmtCost, fmtInt, fmtMinutes, fmtTokens, getJson, postJson, relTime, shortDay } from "./api.ts";
import { HBars, HourBars, Legend, SLOTS, type StackDay, StackedBars, Tooltip, type Tip, seriesVar } from "./charts.tsx";
import { type Key, type Lang, detectLang, translate } from "./i18n.ts";

/**
 * The dashboard. State that a link should carry (range, models, machines)
 * lives in the URL; which cards are collapsed lives in localStorage. The
 * summary is re-read every 60 s while the tab is visible.
 */

const RANGES = ["5h", "today", "7d", "30d", "90d", "all"] as const;
type Range = (typeof RANGES)[number];
const REFRESH_MS = 60_000;

/** `claude-haiku-4-5-20251001` -> `haiku 4.5`; the page's copy of the server's helper. */
const shortModel = (model: string): string => {
  const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/);
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model;
};

function readParams(): { range: Range; models: string[]; machines: string[] } {
  const p = new URLSearchParams(location.search);
  const range = p.get("range") as Range;
  const list = (k: string) => (p.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { range: RANGES.includes(range) ? range : "7d", models: list("models"), machines: list("machines") };
}

function writeParams(range: Range, models: string[], machines: string[]): void {
  const p = new URLSearchParams(location.search);
  p.set("range", range);
  if (models.length) p.set("models", models.join(","));
  else p.delete("models");
  if (machines.length) p.set("machines", machines.join(","));
  else p.delete("machines");
  history.replaceState(null, "", `?${p}`);
}

function useCollapsed(): [Set<string>, (k: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("usage-collapsed") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (k: string) =>
    setSet((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      try {
        localStorage.setItem("usage-collapsed", JSON.stringify([...n]));
      } catch {
        /* private mode */
      }
      return n;
    });
  return [set, toggle];
}

function Card({ id, title, hint, right, collapsed, onToggle, children }: { id: string; title: string; hint?: string; right?: ReactNode; collapsed: Set<string>; onToggle: (k: string) => void; children: ReactNode }) {
  const closed = collapsed.has(id);
  return (
    <section className={`card${closed ? " closed" : ""}`} id={id}>
      <div className="card-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
        <span className="spacer" />
        {right}
        <button className="caret" onClick={() => onToggle(id)} aria-expanded={!closed}>
          {closed ? "▸" : "▾"}
        </button>
      </div>
      <div className="card-body">{children}</div>
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
    <th className={`${left ? "l" : ""}${on ? " on" : ""}`} onClick={() => onSort(k)}>
      {label}
      {on ? (dir === "desc" ? " ↓" : " ↑") : ""}
    </th>
  );
}

function Rows<T>({ rows, limit, render, t }: { rows: T[]; limit: number; render: (r: T, i: number) => ReactNode; t: (k: Key, v?: Record<string, string | number>) => string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, limit);
  return (
    <>
      <tbody>{shown.map(render)}</tbody>
      {rows.length > limit && (
        <tfoot>
          <tr>
            <td colSpan={99} className="l">
              <button className="more" onClick={() => setOpen(!open)}>
                {open ? t("showLess") : t("showMore", { n: rows.length - limit })}
              </button>
            </td>
          </tr>
        </tfoot>
      )}
    </>
  );
}

const TokenCells = ({ r, lang }: { r: Totals; lang: Lang }) => (
  <>
    <td>{fmtInt(r.turns, lang)}</td>
    <td>{fmtTokens(r.input)}</td>
    <td>{fmtTokens(r.output)}</td>
    <td>{fmtTokens(r.cacheRead)}</td>
    <td>{fmtTokens(r.cacheWrite)}</td>
    <td>{fmtTokens(r.tokens)}</td>
    <td>{fmtCost(r.cost, lang)}</td>
  </>
);

export default function App() {
  const [lang] = useState<Lang>(() => detectLang());
  const t = useCallback((k: Key, v?: Record<string, string | number>) => translate(lang, k, v), [lang]);
  const [{ range, models, machines }, setParams] = useState(readParams);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<Tip>(null);
  const [collapsed, toggleCard] = useCollapsed();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const load = useCallback(() => {
    const q = new URLSearchParams({ range, tz });
    if (models.length) q.set("models", models.join(","));
    if (machines.length) q.set("machines", machines.join(","));
    return Promise.all([getJson<Summary>(`/api/summary?${q}`), getJson<Status>("/api/status")])
      .then(([s, st]) => {
        setSummary(s);
        setStatus(st);
        setErr("");
      })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [range, models, machines, tz]);

  useEffect(() => {
    writeParams(range, models, machines);
    load();
    const timer = setInterval(() => !document.hidden && load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, range, models, machines]);

  useEffect(() => {
    document.title = t("title");
  }, [t]);

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
  const setRange = (r: Range) => setParams((p) => ({ ...p, range: r }));
  const toggleModel = (m: string) => setParams((p) => ({ ...p, models: toggleIn(p.models, m) }));
  const toggleMachine = (m: string) => setParams((p) => ({ ...p, machines: toggleIn(p.machines, m) }));

  const tot = summary?.totals;
  const multiMachine = (summary?.machines.length ?? 0) > 1;

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

  return (
    <div className="page">
      <header className="head">
        <h1>
          <img src="/icon.svg" alt="" />
          {t("title")}
        </h1>
        <span className="sub">{t("subtitle")}</span>
        <div className="meta">
          {status && (
            <>
              <span title={status.sources.join("\n")}>
                {status.machine} · {t("files", { n: status.files })} · {status.lastScan ? t("lastScan", { ago: relTime(status.lastScan, lang) }) : t("never")}
              </span>
              {status.peers.map((p) => (
                <span key={p.name} className={`peer${p.ok ? "" : " down"}`} title={p.ok ? t("peerOk", { name: p.name, ago: p.lastPullAt ? relTime(p.lastPullAt, lang) : t("never") }) : t("peerDown", { name: p.name, error: p.error ?? "" })}>
                  <i />
                  {p.name}
                </span>
              ))}
            </>
          )}
          <button className="btn" onClick={refresh} disabled={busy}>
            {busy ? t("refreshing") : `↻ ${t("refresh")}`}
          </button>
        </div>
      </header>

      <div className="filters">
        <div className="filter">
          <span>{t("range")}</span>
          <span className="seg">
            {RANGES.map((r) => (
              <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
                {t(`range.${r}` as Key)}
              </button>
            ))}
          </span>
        </div>
        {summary && summary.models.length > 0 && (
          <div className="filter">
            <span>{t("models")}</span>
            <button className={`chip${models.length ? "" : " on"}`} onClick={() => setParams((p) => ({ ...p, models: [] }))}>
              {t("all")}
            </button>
            {summary.models.map((m) => (
              <button key={m.model} className={`chip${models.includes(m.model) ? " on" : ""}`} onClick={() => toggleModel(m.model)} title={`${m.model} · ${fmtInt(m.turns, lang)} ${t("turns").toLowerCase()}`}>
                <i style={{ background: colorOf(m.model) }} />
                {modelLabel(m.model)}
              </button>
            ))}
          </div>
        )}
        {multiMachine && summary && (
          <div className="filter">
            <span>{t("machines")}</span>
            <button className={`chip${machines.length ? "" : " on"}`} onClick={() => setParams((p) => ({ ...p, machines: [] }))}>
              {t("all")}
            </button>
            {summary.machines.map((m) => (
              <button key={m.machine} className={`chip${machines.includes(m.machine) ? " on" : ""}`} onClick={() => toggleMachine(m.machine)}>
                {m.machine}
                {m.local && <small>{t("thisMachine")}</small>}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p className="note">{t("unavailable", { error: err })}</p>}
      {!summary && !err && <p className="note">{t("loading")}</p>}
      {summary && status && status.turns === 0 && <p className="empty">{t("noData", { sources: status.sources.join(", ") })}</p>}

      {summary && tot && (
        <>
          <div className="stats">
            <div className="stat">
              <b>{fmtTokens(tot.tokens)}</b>
              <span>{t("tokens")}{tot.subagentTokens ? ` · ${t("subagentShare", { pct: Math.round((tot.subagentTokens / Math.max(1, tot.tokens)) * 100) })}` : ""}</span>
            </div>
            <div className="stat" title={t("costHint", { asOf: status?.pricingAsOf ?? "" })}>
              <b>{fmtCost(tot.cost, lang)}</b>
              <span>{t("cost")}</span>
            </div>
            <div className="stat">
              <b>{fmtInt(tot.sessions, lang)}</b>
              <span>{t("sessions")}</span>
            </div>
            <div className="stat">
              <b>{fmtInt(tot.turns, lang)}</b>
              <span>{t("turns")}</span>
            </div>
            <div className="stat" title={t("perDayHint", { n: summary.daily.length })}>
              <b>{fmtTokens(tot.perDay.tokens)}</b>
              <span>
                {t("perDay")} · {fmtCost(tot.perDay.cost, lang)}
              </span>
            </div>
          </div>

          {tot.turns === 0 && status && status.turns > 0 && <p className="empty">{t("empty")}</p>}

          {tot.turns > 0 && (
            <>
              <Card id="daily" title={t("daily")} hint={t("dailyByModel")} collapsed={collapsed} onToggle={toggleCard}>
                <StackedBars
                  days={stackDays}
                  slotOf={stackSlot}
                  fmt={fmtTokens}
                  onTip={setTip}
                  onLeave={() => setTip(null)}
                  tipBody={(d) => {
                    const day = summary.daily.find((x) => x.day === d.key);
                    return (
                      <>
                        <b>
                          {d.key} · {t("tokensOn", { tokens: fmtTokens(d.total), cost: fmtCost(day?.cost ?? null, lang) })}
                        </b>
                        {[...d.parts].reverse().map((p) => (
                          <div key={p.series} className="row">
                            <span>
                              <i style={{ background: seriesVar(stackSlot(p.series)) }} />
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

              <div className="grid">
                <Card id="hourly" title={t("hourly")} hint={t("hourlyHint", { n: summary.hourlyDays })} collapsed={collapsed} onToggle={toggleCard}>
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
                </Card>
                <Card id="models" title={t("byModel")} collapsed={collapsed} onToggle={toggleCard}>
                  <HBars
                    rows={summary.byModel.map((m) => ({ key: m.model, label: modelLabel(m.model), value: m.tokens, title: `${m.model} · ${fmtCost(m.cost, lang)}` }))}
                    colorOf={colorOf}
                    fmt={fmtTokens}
                  />
                </Card>
              </div>

              <div className="grid">
                {multiMachine ? (
                  <Card id="machines" title={t("byMachine")} collapsed={collapsed} onToggle={toggleCard}>
                    <HBars rows={summary.byMachine.map((m) => ({ key: m.machine, label: m.machine, value: m.tokens, title: `${fmtCost(m.cost, lang)} · ${m.sessions} ${t("sessions").toLowerCase()}` }))} fmt={fmtTokens} />
                  </Card>
                ) : null}
                <Card id="projects" title={t("byProject")} collapsed={collapsed} onToggle={toggleCard}>
                  <HBars
                    rows={summary.byProject.slice(0, 10).map((p) => ({
                      key: `${p.machine}/${p.project}`,
                      label: (
                        <>
                          {multiMachine && <span className="tag">{p.machine}</span>}
                          {p.project}
                        </>
                      ),
                      value: p.tokens,
                      title: `${fmtCost(p.cost, lang)} · ${p.sessions} ${t("sessions").toLowerCase()}`,
                    }))}
                    fmt={fmtTokens}
                  />
                </Card>
                {!multiMachine && (
                  <Card id="subagents" title={t("subagents")} collapsed={collapsed} onToggle={toggleCard}>
                    {summary.subagents.length ? <HBars rows={summary.subagents.map((s) => ({ key: s.type, label: s.type, value: s.tokens, title: `${s.dispatches} · ${fmtCost(s.cost, lang)}` }))} fmt={fmtTokens} /> : <p className="note">{t("noSubagents")}</p>}
                  </Card>
                )}
              </div>
              {multiMachine && (
                <Card id="subagents" title={t("subagents")} collapsed={collapsed} onToggle={toggleCard}>
                  {summary.subagents.length ? <HBars rows={summary.subagents.map((s) => ({ key: s.type, label: s.type, value: s.tokens, title: `${s.dispatches} · ${fmtCost(s.cost, lang)}` }))} fmt={fmtTokens} /> : <p className="note">{t("noSubagents")}</p>}
                </Card>
              )}

              <Card id="cost-model" title={t("costByModel")} collapsed={collapsed} onToggle={toggleCard}>
                <div className="scroll">
                  <table>
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
                      </tr>
                    </thead>
                    <tbody>
                      {sortRows(summary.byModel, mSort, mDir).map((m) => (
                        <tr key={m.model}>
                          <td className="l">
                            <i className="swatch" style={{ background: colorOf(m.model) }} />
                            {m.model}
                          </td>
                          <TokenCells r={m} lang={lang} />
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="l">{t("total")}</td>
                        <TokenCells r={{ ...tot, cost: sumCost(summary.byModel) }} lang={lang} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>

              <Card id="sessions" title={t("sessionsTable")} hint={`${fmtInt(summary.sessions.length, lang)}`} collapsed={collapsed} onToggle={toggleCard}>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <Th k="project" label={t("col.project")} sortKey={sSort} dir={sDir} onSort={setSSort} left />
                        <th className="l">{t("col.topic")}</th>
                        <th className="l">{t("col.model")}</th>
                        <Th k="last" label={t("col.last")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                        <Th k="durationMin" label={t("col.duration")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                        <Th k="turns" label={t("col.turns")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                        <Th k="tokens" label={t("col.tokens")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                        <Th k="cost" label={t("col.cost")} sortKey={sSort} dir={sDir} onSort={setSSort} />
                      </tr>
                    </thead>
                    <Rows
                      rows={sortRows(summary.sessions, sSort, sDir)}
                      limit={15}
                      t={t}
                      render={(s) => (
                        <tr key={s.sessionId} title={`${s.sessionId}\n${s.branch ? `branch ${s.branch}\n` : ""}${s.subagentTokens ? `${fmtTokens(s.subagentTokens)} tokens by subagents` : ""}`}>
                          <td className="l ell">
                            {multiMachine && <span className="tag">{s.machine}</span>}
                            {s.project}
                          </td>
                          <td className="l ell dim">{s.topic ?? ""}</td>
                          <td className="l">
                            <i className="swatch" style={{ background: colorOf(s.model) }} />
                            {modelLabel(s.model)}
                          </td>
                          <td title={dateTime(s.last, lang)}>{relTime(s.last, lang)}</td>
                          <td>{fmtMinutes(s.durationMin, lang)}</td>
                          <td>{fmtInt(s.turns, lang)}</td>
                          <td>{fmtTokens(s.tokens)}</td>
                          <td>{fmtCost(s.cost, lang)}</td>
                        </tr>
                      )}
                    />
                  </table>
                </div>
              </Card>

              {summary.dispatches.length > 0 && (
                <Card id="dispatches" title={t("dispatches")} hint={`${fmtInt(summary.dispatches.length, lang)}`} collapsed={collapsed} onToggle={toggleCard}>
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th className="l">{t("col.type")}</th>
                          <th className="l">{t("col.project")}</th>
                          <th className="l">{t("col.status")}</th>
                          <th>{t("col.completed")}</th>
                          <th>{t("col.duration")}</th>
                          <th>{t("col.tools")}</th>
                          <th>{t("col.tokens")}</th>
                          <th>{t("col.cost")}</th>
                        </tr>
                      </thead>
                      <Rows
                        rows={summary.dispatches}
                        limit={10}
                        t={t}
                        render={(d) => (
                          <tr key={d.agentId} title={d.agentId}>
                            <td className="l">{d.type}</td>
                            <td className="l ell">
                              {multiMachine && <span className="tag">{d.machine}</span>}
                              {d.project}
                            </td>
                            <td className="l dim">{d.status ?? ""}</td>
                            <td title={d.completedAt ? dateTime(d.completedAt, lang) : ""}>{d.completedAt ? relTime(d.completedAt, lang) : ""}</td>
                            <td>{d.durationMs !== null ? fmtMinutes(Math.round(d.durationMs / 60_000), lang) : ""}</td>
                            <td>{d.toolUses ?? ""}</td>
                            <td>{fmtTokens(d.tokens)}</td>
                            <td>{fmtCost(d.cost, lang)}</td>
                          </tr>
                        )}
                      />
                    </table>
                  </div>
                </Card>
              )}

              <Card id="cost-project" title={t("projectsTable")} collapsed={collapsed} onToggle={toggleCard}>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <Th k="project" label={t("col.project")} sortKey={pSort} dir={pDir} onSort={setPSort} left />
                        <Th k="sessions" label={t("col.sessions")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                        <Th k="turns" label={t("col.turns")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                        <Th k="tokens" label={t("col.tokens")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                        <th>{t("col.share")}</th>
                        <Th k="cost" label={t("col.cost")} sortKey={pSort} dir={pDir} onSort={setPSort} />
                      </tr>
                    </thead>
                    <Rows
                      rows={sortRows(summary.byProject, pSort, pDir)}
                      limit={15}
                      t={t}
                      render={(p) => (
                        <tr key={`${p.machine}/${p.project}`}>
                          <td className="l ell">
                            {multiMachine && <span className="tag">{p.machine}</span>}
                            {p.project}
                          </td>
                          <td>{fmtInt(p.sessions, lang)}</td>
                          <td>{fmtInt(p.turns, lang)}</td>
                          <td>{fmtTokens(p.tokens)}</td>
                          <td className="dim">{Math.round((p.tokens / Math.max(1, tot.tokens)) * 100)}%</td>
                          <td>{fmtCost(p.cost, lang)}</td>
                        </tr>
                      )}
                    />
                  </table>
                </div>
              </Card>

              <Card id="cost-branch" title={t("branchesTable")} collapsed={collapsed} onToggle={toggleCard}>
                <div className="scroll">
                  <table>
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
                      rows={sortRows(summary.byBranch, bSort, bDir)}
                      limit={15}
                      t={t}
                      render={(b) => (
                        <tr key={`${b.machine}/${b.project}/${b.branch}`}>
                          <td className="l ell">
                            {multiMachine && <span className="tag">{b.machine}</span>}
                            {b.project}
                          </td>
                          <td className="l dim">{b.branch || "–"}</td>
                          <td>{fmtInt(b.sessions, lang)}</td>
                          <td>{fmtInt(b.turns, lang)}</td>
                          <td>{fmtTokens(b.tokens)}</td>
                          <td>{fmtCost(b.cost, lang)}</td>
                        </tr>
                      )}
                    />
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}

      <p className="footer">{t("footer", { asOf: status?.pricingAsOf ?? "" })}</p>
      <Tooltip tip={tip} />
    </div>
  );
}
