// Small SVG charts with hover tooltips. Single series each, so no legend box:
// the card title names what is shown.

import React, { useMemo, useRef, useState } from 'react';

const W = 760;
const PAD = { l: 52, r: 12, t: 12, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Round tick values from 0 to a little above `max`. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const step = niceMax(max / 4);
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

function timeTicks(from: number, to: number): Array<{ t: number; label: string }> {
  const span = to - from;
  const H = 3_600_000;
  const out: Array<{ t: number; label: string }> = [];
  if (span <= 36 * H) {
    const step = span <= 12 * H ? 2 * H : span <= 24 * H ? 4 * H : 6 * H;
    const start = new Date(from);
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime(); t <= to; t += H) {
      const d = new Date(t);
      if (t >= from && (d.getHours() * H) % step === 0)
        out.push({ t, label: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
    }
  } else {
    const days = span / (24 * H);
    const every = days <= 8 ? 1 : days <= 16 ? 2 : days <= 40 ? 5 : 14;
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    let i = 0;
    for (let d = new Date(start); d.getTime() <= to; d.setDate(d.getDate() + 1), i++) {
      if (d.getTime() >= from && i % every === 0)
        out.push({ t: d.getTime(), label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
    }
  }
  return out;
}

function useHover() {
  const ref = useRef<SVGSVGElement>(null);
  const [x, setX] = useState<number | null>(null);
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setX(((e.clientX - r.left) / r.width) * W);
  };
  return { ref, x, onMove, onLeave: () => setX(null) };
}

function Tooltip({ x, height, children }: { x: number; height: number; children: React.ReactNode }) {
  const left = (x / W) * 100;
  return (
    <div className="tooltip" style={{ left: `${left}%`, top: 4, transform: `translateX(${left > 60 ? 'calc(-100% - 10px)' : '10px'})`, maxHeight: height }}>
      {children}
    </div>
  );
}

export interface TimePoint {
  t: number;
  v: number;
}

/**
 * A value over time drawn as steps: units report when something changes, so a
 * value holds until the next report.
 */
export function StepChart({
  points,
  from,
  to,
  format,
  axisFormat,
  height = 200,
  label,
}: {
  points: TimePoint[];
  from: number;
  to: number;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  label: string;
}) {
  const hover = useHover();
  const end = Math.min(to, Date.now());
  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.map((p) => p.v))), [points]);
  const max = ticks[ticks.length - 1];
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (height - PAD.t - PAD.b);
  const pts = points.map((p) => ({ t: Math.max(p.t, from), v: p.v }));

  let d = '';
  pts.forEach((p, i) => {
    const next = i + 1 < pts.length ? pts[i + 1].t : end;
    d += `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}H${x(next).toFixed(1)}`;
  });
  const area = pts.length ? `${d}V${y(0)}H${x(pts[0].t)}Z` : '';

  let hoverInfo: { t: number; v: number } | null = null;
  if (hover.x !== null && pts.length) {
    const t = from + ((hover.x - PAD.l) / (W - PAD.l - PAD.r)) * (to - from);
    const at = [...pts].reverse().find((p) => p.t <= t);
    if (at && t <= end) hoverInfo = { t, v: at.v };
  }

  return (
    <div className="chart" role="img" aria-label={label}>
      <svg ref={hover.ref} viewBox={`0 0 ${W} ${height}`} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
              {(axisFormat ?? format)(v)}
            </text>
          </g>
        ))}
        {timeTicks(from, to).map((tk) => (
          <text key={tk.t} className="axis" x={x(tk.t)} y={height - 8} textAnchor="middle">
            {tk.label}
          </text>
        ))}
        {pts.length > 0 && <path d={area} className="area" />}
        {pts.length > 0 && <path d={d} className="line" />}
        {hoverInfo && (
          <>
            <line className="crosshair" x1={x(hoverInfo.t)} x2={x(hoverInfo.t)} y1={PAD.t} y2={height - PAD.b} />
            <circle className="dot" cx={x(hoverInfo.t)} cy={y(hoverInfo.v)} r={4} />
          </>
        )}
        <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={height} fill="transparent" />
      </svg>
      {pts.length === 0 && <div className="chart-empty">No readings in this period</div>}
      {hoverInfo && hover.x !== null && (
        <Tooltip x={hover.x} height={height}>
          <div className="tt-title">{new Date(hoverInfo.t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          <div className="tt-value">{format(hoverInfo.v)}</div>
        </Tooltip>
      )}
    </div>
  );
}

/** On/off over time, one row per channel. */
export function OnOffChart({
  rows,
  from,
  to,
}: {
  rows: Array<{ label: string; points: Array<{ t: number; on: boolean }> }>;
  from: number;
  to: number;
}) {
  const hover = useHover();
  const rowH = 22;
  const gap = 10;
  const height = PAD.t + rows.length * (rowH + gap) + PAD.b;
  const end = Math.min(to, Date.now());
  const x = (t: number) => PAD.l + ((Math.max(from, Math.min(t, to)) - from) / (to - from)) * (W - PAD.l - PAD.r);
  const segments = rows.map((r) => {
    const segs: Array<{ a: number; b: number; on: boolean }> = [];
    r.points.forEach((p, i) => {
      const b = i + 1 < r.points.length ? r.points[i + 1].t : end;
      if (b <= from) return;
      const last = segs[segs.length - 1];
      if (last && last.on === p.on) last.b = b; // same state reported again: extend
      else segs.push({ a: Math.max(p.t, from), b, on: p.on });
    });
    return segs;
  });

  // Tooltip: the state of every channel at the hovered time.
  let tip: Array<{ label: string; on: boolean; since: number }> = [];
  if (hover.x !== null) {
    const t = from + ((hover.x - PAD.l) / (W - PAD.l - PAD.r)) * (to - from);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i].find((seg) => seg.a <= t && t < seg.b);
      if (s) tip.push({ label: rows[i].label, on: s.on, since: s.a });
    }
  }

  return (
    <div className="chart" role="img" aria-label="On/off history">
      <svg ref={hover.ref} viewBox={`0 0 ${W} ${height}`} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}>
        {rows.map((r, i) => {
          const yTop = PAD.t + i * (rowH + gap);
          return (
            <g key={r.label}>
              <rect className="track" x={PAD.l} y={yTop} width={W - PAD.l - PAD.r} height={rowH} rx={4} />
              {segments[i]
                .filter((s) => s.on)
                .map((s) => (
                  <rect key={s.a} className="on-seg" x={x(s.a)} y={yTop} width={Math.max(2, x(s.b) - x(s.a))} height={rowH} rx={4} />
                ))}
              <text className="axis" x={PAD.l - 8} y={yTop + rowH / 2 + 4} textAnchor="end">
                {r.label.length > 10 ? `${r.label.slice(0, 9)}…` : r.label}
              </text>
            </g>
          );
        })}
        {timeTicks(from, to).map((tk) => (
          <text key={tk.t} className="axis" x={x(tk.t)} y={height - 8} textAnchor="middle">
            {tk.label}
          </text>
        ))}
        {hover.x !== null && hover.x >= PAD.l && <line className="crosshair" x1={hover.x} x2={hover.x} y1={PAD.t} y2={height - PAD.b} />}
      </svg>
      {tip.length > 0 && hover.x !== null && (
        <Tooltip x={hover.x} height={height}>
          {tip.map((r) => (
            <div key={r.label}>
              <div className="tt-title">{r.label}</div>
              <div className="tt-value">{r.on ? 'On' : 'Off'}</div>
              <div className="tt-sub">since {new Date(r.since).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** Vertical bars, e.g. energy per day. */
export function BarChart({
  bars,
  format,
  axisFormat,
  height = 220,
  label,
}: {
  bars: Array<{ key: string; label: string; value: number; note?: string }>;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  label: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(0, ...bars.map((b) => b.value)));
  const max = ticks[ticks.length - 1];
  const plotW = W - PAD.l - PAD.r;
  const slot = bars.length ? plotW / bars.length : plotW;
  const barW = Math.max(2, Math.min(48, slot - 2));
  const y = (v: number) => PAD.t + (1 - v / max) * (height - PAD.t - PAD.b);
  const base = y(0);
  const labelEvery = Math.ceil(bars.length / 12);

  return (
    <div className="chart" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${W} ${height}`} onPointerLeave={() => setHoverIndex(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
              {(axisFormat ?? format)(v)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = PAD.l + slot * i + slot / 2;
          const top = y(b.value);
          const h = Math.max(0, base - top);
          const r = Math.min(4, h, barW / 2);
          // Rounded top, square at the baseline.
          const path = h > 0
            ? `M${cx - barW / 2},${base}V${top + r}Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top}H${cx + barW / 2 - r}Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r}V${base}Z`
            : '';
          return (
            <g key={b.key} onPointerEnter={() => setHoverIndex(i)}>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={height - PAD.t - PAD.b} fill="transparent" />
              {path && <path d={path} className={hoverIndex === i ? 'bar bar-hover' : 'bar'} />}
              {i % labelEvery === 0 && (
                <text className="axis" x={cx} y={height - 8} textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {bars.length === 0 && <div className="chart-empty">No energy recorded in this period</div>}
      {hoverIndex !== null && bars[hoverIndex] && (
        <Tooltip x={PAD.l + slot * hoverIndex + slot / 2} height={height}>
          <div className="tt-title">{bars[hoverIndex].label}</div>
          <div className="tt-value">{format(bars[hoverIndex].value)}</div>
          {bars[hoverIndex].note && <div className="tt-sub">{bars[hoverIndex].note}</div>}
        </Tooltip>
      )}
    </div>
  );
}
