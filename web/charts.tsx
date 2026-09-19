import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The charts, drawn with inline SVG and plain HTML so the page ships no chart
 * library. Colours come from CSS custom properties (`--s1`…`--s8` for the
 * series slots, `--s-other` for what folds into "other"), so the dark theme
 * is a stylesheet concern. Every mark has a hover tooltip and hit targets
 * wider than the mark; identity is never colour alone: stacks carry a legend
 * with direct labels, bars carry their value.
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
  height = 200,
}: {
  days: StackDay[];
  /** Series -> colour slot index (stable across filters). */
  slotOf: (series: string) => number;
  fmt: (v: number) => string;
  onTip: (t: Tip) => void;
  onLeave: () => void;
  tipBody: (d: StackDay) => ReactNode;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...days.map((d) => d.total));
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const n = Math.max(1, days.length);
  const slot = w / n;
  const gap = slot > 14 ? 3 : slot > 6 ? 2 : 1;
  const bw = Math.max(1, slot - gap);
  const ticks = niceTicks(max, 4);
  // Label every k-th day so labels never collide (about 56px each).
  const every = Math.max(1, Math.ceil(56 / Math.max(slot, 1)));
  return (
    <div ref={ref} className="chart-box">
      {width > 0 && (
        <svg width={width} height={height} className="chart" role="img">
          {ticks.map((v) => {
            const y = pad.t + h - (v / max) * h;
            return (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + w} y1={y} y2={y} className="grid" />
                <text x={pad.l - 6} y={y + 3.5} className="axis" textAnchor="end">
                  {fmt(v)}
                </text>
              </g>
            );
          })}
          <line x1={pad.l} x2={pad.l + w} y1={pad.t + h} y2={pad.t + h} className="baseline" />
          {days.map((d, i) => {
            const x = pad.l + i * slot + gap / 2;
            let y = pad.t + h;
            const rects = d.parts
              .filter((p) => p.value > 0)
              .map((p, j, arr) => {
                const ph = (p.value / max) * h;
                y -= ph;
                const top = j === arr.length - 1;
                return <rect key={p.series} x={x} y={y} width={bw} height={Math.max(0.5, ph - (j === 0 ? 0 : 1))} rx={top ? Math.min(3, bw / 2) : 0} fill={seriesVar(slotOf(p.series))} />;
              });
            return (
              <g key={d.key} onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, body: tipBody(d) })} onMouseLeave={onLeave}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={h} className="hit" />
                {rects}
                {i % every === 0 && (
                  <text x={x + bw / 2} y={height - 6} className="axis" textAnchor="middle">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
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

export function HourBars({ hours, fmt, onTip, onLeave, label }: { hours: { hour: number; value: number }[]; fmt: (v: number) => string; onTip: (t: Tip) => void; onLeave: () => void; label: (h: number, v: number) => ReactNode }) {
  const max = Math.max(1, ...hours.map((h) => h.value));
  return (
    <div className="hours" onMouseLeave={onLeave}>
      {hours.map((h) => (
        <div key={h.hour} className="hour" onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, body: label(h.hour, h.value) })} title={`${h.hour}:00 · ${fmt(h.value)}`}>
          <i style={{ height: `${Math.max(h.value > 0 ? 3 : 0, (h.value / max) * 100)}%` }} />
          {h.hour % 6 === 0 && <span>{h.hour}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- horizontal bars

export function HBars({ rows, colorOf, fmt, sub }: { rows: { key: string; label: ReactNode; value: number; title?: string }[]; colorOf?: (key: string) => string; fmt: (v: number) => string; sub?: (key: string) => ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.key} className="hbar" title={r.title}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track">
            <i style={{ width: `${(r.value / max) * 100}%`, background: colorOf ? colorOf(r.key) : "var(--s1)" }} />
          </span>
          <span className="hbar-val">
            {fmt(r.value)}
            <small>{Math.round((r.value / total) * 100)}%</small>
          </span>
          {sub && <span className="hbar-sub">{sub(r.key)}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- legend

export function Legend({ items }: { items: { key: string; label: string; slot: number; value?: string }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key} className="legend-item">
          <i style={{ background: seriesVar(it.slot) }} />
          {it.label}
          {it.value && <b>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}
