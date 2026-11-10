import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The charts, drawn with inline SVG and plain HTML so the page ships no chart
 * library. Colours come from CSS custom properties (`--s1`…`--s8` for the
 * series slots, `--s-other` for what folds into "other"; web/styles.css), so
 * the dark theme is a stylesheet concern. The kit's accent marks today only,
 * never a series. Every mark has a hover tooltip and hit targets wider than
 * the mark; identity is never colour alone: stacks carry a legend with values,
 * bars carry their value.
 */

/** The categorical slots, by series index; past the eighth everything is "other". */
export const SLOTS = 8;
export const seriesVar = (i: number): string => (i < SLOTS ? `var(--s${i + 1})` : "var(--s-other)");

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e?.contentRect.width ?? 0));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- tooltip

export type Tip = { x: number; y: number; body: ReactNode } | null;

/** One floating tooltip per page, positioned by the pointer and kept inside the viewport. */
export function Tooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14;
    let top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  if (!tip) return null;
  return (
    <div ref={ref} className="tip" style={{ left: pos.left, top: pos.top }} role="tooltip">
      {tip.body}
    </div>
  );
}

// ---------------------------------------------------------------- stacked daily bars

export type StackDay = { key: string; label: string; total: number; parts: { series: string; value: number }[] };

export function StackedBars({
  days,
  slotOf,
  fmt,
  onTip,
  onLeave,
  tipBody,
  today,
  todayLabel,
  avg,
  avgLabel,
  height = 220,
}: {
  days: StackDay[];
  /** Series -> colour slot index (stable across filters). */
  slotOf: (series: string) => number;
  fmt: (v: number) => string;
  onTip: (t: Tip) => void;
  onLeave: () => void;
  tipBody: (d: StackDay) => ReactNode;
  /** The viewer's today (`YYYY-MM-DD`), marked with the accent. */
  today?: string;
  todayLabel?: string;
  /** The daily average, drawn as a dashed line when there is more than one day. */
  avg?: number;
  avgLabel?: (v: string) => string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = Math.max(1, days.length);
  const pad = { l: 56, r: 8, t: 10 };
  const w = Math.max(0, width - pad.l - pad.r);
  const slot = w / n;
  // Two-line labels (day, then its total) when a day has room for them.
  const rich = slot >= 52;
  const bottom = rich ? 40 : 22;
  const h = height - pad.t - bottom;
  const max = Math.max(1, ...days.map((d) => d.total), avg ?? 0);
  const bw = Math.max(1, Math.min(18, slot * 0.56));
  const ticks = niceTicks(max, 4);
  // Label every k-th day so labels never collide (about 56px each).
  const every = Math.max(1, Math.ceil(56 / Math.max(slot, 1)));
  const showAvg = avg !== undefined && avg > 0 && days.length > 1;
  const avgY = showAvg ? pad.t + h - (avg / max) * h : 0;
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={width} height={height} className="chart" role="img">
          {ticks.map((v) => {
            const y = pad.t + h - (v / max) * h;
            return (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + w} y1={y} y2={y} className="grid" />
                <text x={pad.l - 8} y={y + 4} className="axis" textAnchor="end">
                  {fmt(v)}
                </text>
              </g>
            );
          })}
          {days.map((d, i) => {
            const cx = pad.l + i * slot + slot / 2;
            const x = cx - bw / 2;
            const isToday = d.key === today;
            let y = pad.t + h;
            const parts = d.parts.filter((p) => p.value > 0);
            const rects = parts.map((p, j) => {
              const ph = (p.value / max) * h;
              y -= ph;
              const top = j === parts.length - 1;
              // A 1px surface gap between stacked segments; the top keeps a small round end.
              return <rect key={p.series} x={x} y={y} width={bw} height={Math.max(0.5, ph - (j === 0 ? 0 : 1))} rx={top ? Math.min(2, bw / 2) : 0} fill={seriesVar(slotOf(p.series))} />;
            });
            const labelled = i % every === 0 || isToday;
            return (
              <g key={d.key} className={isToday ? "day today" : "day"} onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, body: tipBody(d) })} onMouseLeave={onLeave}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={h} rx={6} className="hit" />
                {rects}
                {isToday && <rect x={pad.l + i * slot + 2} y={pad.t + h} width={Math.max(2, slot - 4)} height={2} className="today-mark" />}
                {labelled && (
                  <text x={cx} y={pad.t + h + 16} className={isToday ? "axis day-label now" : "axis day-label"} textAnchor="middle">
                    {d.label}
                  </text>
                )}
                {rich && (
                  <text x={cx} y={pad.t + h + 32} className="axis" textAnchor="middle">
                    {d.total ? fmt(d.total) : ""}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={pad.l} x2={pad.l + w} y1={pad.t + h} y2={pad.t + h} className="baseline" />
          {showAvg && (
            <g className="avg" pointerEvents="none">
              <line x1={pad.l} x2={pad.l + w} y1={avgY} y2={avgY} />
              <text x={pad.l + w} y={avgY - 5} textAnchor="end" className="axis avg-label">
                {avgLabel ? avgLabel(fmt(avg)) : fmt(avg)}
              </text>
            </g>
          )}
          {today && todayLabel && days.some((d) => d.key === today) && <title>{todayLabel}</title>}
        </svg>
      )}
    </div>
  );
}

function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------- hourly bars

/** Twenty-four thin bars; the busiest hour is ink and labelled, the rest the kit's bar grey. */
export function HourBars({ hours, fmt, onTip, onLeave, label }: { hours: { hour: number; value: number }[]; fmt: (v: number) => string; onTip: (t: Tip) => void; onLeave: () => void; label: (h: number, v: number) => ReactNode }) {
  const max = Math.max(1, ...hours.map((h) => h.value));
  const peak = hours.reduce<number | null>((p, h) => (h.value > 0 && (p === null || h.value > (hours[p]?.value ?? 0)) ? hours.indexOf(h) : p), null);
  return (
    <div className="hours-box">
      <div className="hours" onMouseLeave={onLeave}>
        {hours.map((h, i) => (
          <div key={h.hour} className={i === peak ? "hour pk" : "hour"} onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, body: label(h.hour, h.value) })} title={`${h.hour}:00 · ${fmt(h.value)}`}>
            <i style={{ height: `${Math.max(h.value > 0 ? 2 : 0, (h.value / max) * 100)}%` }}>{i === peak && <span className="pk-label">{fmt(h.value)}</span>}</i>
          </div>
        ))}
      </div>
      <div className="hours-axis" aria-hidden="true">
        {hours.map((h) => (
          <span key={h.hour}>{h.hour % 3 === 0 ? h.hour : ""}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ranked bars

/** A ranked list: label and value on one line, a thin track under it (the kit's meter). */
export function HBars({ rows, colorOf, fmt, sub }: { rows: { key: string; label: ReactNode; value: number; title?: string }[]; colorOf?: (key: string) => string; fmt: (v: number) => string; sub?: (key: string) => ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return (
    <ol className="rank">
      {rows.map((r) => (
        <li key={r.key} title={r.title}>
          <div className="rank-top">
            <span className="rank-label">{r.label}</span>
            <span className="rank-val">
              {fmt(r.value)}
              <small>{Math.round((r.value / total) * 100)}%</small>
            </span>
          </div>
          <span className="sp-meter" style={{ "--v": `${(r.value / max) * 100}%` } as CSSProperties}>
            <i style={colorOf ? { background: colorOf(r.key) } : undefined} />
          </span>
          {sub && <span className="rank-sub">{sub(r.key)}</span>}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- legend

export function Legend({ items }: { items: { key: string; label: string; slot: number; value?: string }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key} className="legend-item">
          <i className="sw" style={{ background: seriesVar(it.slot) }} />
          {it.label}
          {it.value && <b>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}
