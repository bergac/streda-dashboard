import React, { useMemo, useState } from 'react';
import { api, useData } from '../api.ts';
import { link } from '../context.ts';
import { BarChart } from '../components/charts.tsx';
import { fmtEnergy, fmtEnergyAxis } from '../format.ts';

type Interval = 'hour' | 'day' | 'month';
interface Preset {
  key: string;
  label: string;
  interval: Interval;
  range: () => { from: Date; to: Date };
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const PRESETS: Preset[] = [
  { key: 'today', label: 'Today', interval: 'hour', range: () => ({ from: startOfDay(new Date()), to: new Date(startOfDay(new Date()).getTime() + 86400_000) }) },
  { key: 'yesterday', label: 'Yesterday', interval: 'hour', range: () => { const t = startOfDay(new Date()); return { from: new Date(t.getTime() - 86400_000), to: t }; } },
  { key: '7d', label: '7 days', interval: 'day', range: () => { const t = startOfDay(new Date()); return { from: new Date(t.getFullYear(), t.getMonth(), t.getDate() - 6), to: new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1) }; } },
  { key: '30d', label: '30 days', interval: 'day', range: () => { const t = startOfDay(new Date()); return { from: new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29), to: new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1) }; } },
  { key: '12m', label: '12 months', interval: 'month', range: () => { const t = new Date(); return { from: new Date(t.getFullYear(), t.getMonth() - 11, 1), to: new Date(t.getFullYear(), t.getMonth() + 1, 1) }; } },
];

const pad = (n: number) => String(n).padStart(2, '0');
const localKey = (d: Date, interval: Interval) =>
  interval === 'month'
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01T00:00:00`
    : interval === 'day'
      ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`;

function periods(from: Date, to: Date, interval: Interval): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const d = new Date(from);
  while (d < to) {
    out.push({
      key: localKey(d, interval),
      label:
        interval === 'hour'
          ? `${pad(d.getHours())}:00`
          : interval === 'day'
            ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            : d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    });
    if (interval === 'hour') d.setHours(d.getHours() + 1);
    else if (interval === 'day') d.setDate(d.getDate() + 1);
    else d.setMonth(d.getMonth() + 1);
  }
  return out;
}

export function EnergyPage() {
  const [preset, setPreset] = useState(PRESETS[2]);
  const [groupBy, setGroupBy] = useState<'unit' | 'room'>('unit');
  const { from, to } = useMemo(() => preset.range(), [preset]);
  const { data, error } = useData(() => api.energy(from, to, preset.interval), [preset]);

  const rows = data ?? [];
  const total = rows.reduce((s, r) => s + r.wh, 0);
  const anyEstimated = rows.some((r) => r.estimated);
  const perPeriod = new Map<string, number>();
  for (const r of rows) perPeriod.set(r.period, (perPeriod.get(r.period) ?? 0) + r.wh);
  const bars = periods(from, to, preset.interval).map((p) => ({ key: p.key, label: p.label, value: perPeriod.get(p.key) ?? 0 }));

  const groups = new Map<string, { key: string; name: string; wh: number; estimated: boolean; href?: string }>();
  for (const r of rows) {
    const key = groupBy === 'unit' ? r.ieeeAddress : r.room ?? '';
    const g = groups.get(key) ?? {
      key,
      name: groupBy === 'unit' ? r.name : r.room ?? 'No room yet',
      wh: 0,
      estimated: false,
      href: groupBy === 'unit' ? link('unit', r.ieeeAddress) : undefined,
    };
    g.wh += r.wh;
    g.estimated ||= r.estimated;
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.wh - a.wh);
  const top = ranked[0]?.wh ?? 0;

  return (
    <>
      <h1>Energy</h1>
      <div className="range-row">
        <div className="segmented" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.key} className={p.key === preset.key ? 'active' : ''} onClick={() => setPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Group by">
          <button className={groupBy === 'unit' ? 'active' : ''} onClick={() => setGroupBy('unit')}>Per unit</button>
          <button className={groupBy === 'room' ? 'active' : ''} onClick={() => setGroupBy('room')}>Per room</button>
        </div>
      </div>
      {error && <p className="text-critical">{error}</p>}

      <section className="card">
        <div className="card-head">
          <h2>Total energy</h2>
          <div className="big">{fmtEnergy(total)}</div>
        </div>
        <BarChart label="Energy per period" bars={bars} format={fmtEnergy} axisFormat={fmtEnergyAxis} />
        <p className="hint">
          {anyEstimated
            ? 'Partly estimated: some units only report current, so power is worked out as amps × mains voltage. '
            : ''}
          Time when the dashboard was not listening (computer asleep, app stopped) is not counted.
        </p>
      </section>

      <section className="card">
        <h2>{groupBy === 'unit' ? 'Per unit' : 'Per room'}</h2>
        {ranked.length === 0 ? (
          <p className="muted">No energy recorded in this period yet.</p>
        ) : (
          <table className="table share">
            <thead>
              <tr><th>{groupBy === 'unit' ? 'Unit' : 'Room'}</th><th className="num">Energy</th><th className="num">Share</th><th aria-hidden></th></tr>
            </thead>
            <tbody>
              {ranked.map((g) => (
                <tr key={g.key}>
                  <td>{g.href ? <a href={g.href}>{g.name}</a> : g.name}{g.estimated && <span className="tag" title="Estimated from current">est.</span>}</td>
                  <td className="num">{fmtEnergy(g.wh)}</td>
                  <td className="num">{total > 0 ? `${Math.round((g.wh / total) * 100)}%` : '—'}</td>
                  <td className="share-cell"><div className="share-bar" style={{ width: `${top > 0 ? (g.wh / top) * 100 : 0}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
