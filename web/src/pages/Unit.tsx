import React, { useEffect, useMemo, useState } from 'react';
import { api, useData, type HistoryPoint } from '../api.ts';
import { link, useApp } from '../context.ts';
import { OnOffChart, StepChart } from '../components/charts.tsx';
import { CATEGORY_ICON, CATEGORY_LABEL, ROLE_ICON, channelLabel, fmtAgo, fmtAxis, fmtDateTime, fmtTime, fmtValue, fmtWatts } from '../format.ts';

const RANGES = [
  { key: '24h', label: '24 hours', ms: 24 * 3600_000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 3600_000 },
  { key: '30d', label: '30 days', ms: 30 * 24 * 3600_000 },
];

const UNIT_FORMAT: Record<string, (v: number) => string> = {
  power: (v) => fmtWatts(v),
  current: (v) => `${v.toFixed(2)} A`,
  voltage: (v) => `${Math.round(v)} V`,
  energy: (v) => `${v.toFixed(2)} kWh`,
  battery: (v) => `${Math.round(v)}%`,
  brightness: (v) => `${Math.round(v)}%`, // converted to percent before charting
  temperature: (v) => `${v.toFixed(1)} °C`,
  humidity: (v) => `${Math.round(v)}%`,
};
const formatFor = (attr: string) => UNIT_FORMAT[attr.replace(/_.*$/, '')] ?? ((v: number) => fmtValue(v));
const AXIS_UNIT: Record<string, string> = { power: ' W', current: ' A', voltage: ' V', energy: ' kWh', battery: '%', brightness: '%', temperature: ' °C', humidity: '%' };
const axisFor = (attr: string) => fmtAxis(AXIS_UNIT[attr.replace(/_.*$/, '')] ?? '');
/** Zigbee brightness runs 0–254; show it as a percentage. */
const toDisplay = (attr: string, v: number) => (attr.startsWith('brightness') ? (v / 254) * 100 : v);

const CHART_TITLE: Record<string, string> = {
  power: 'Power',
  current: 'Current',
  brightness: 'Brightness',
  battery: 'Battery',
  energy: 'Energy counter',
  temperature: 'Temperature',
};

export function UnitPage({ ieee }: { ieee: string }) {
  const { devices, buttonTick } = useApp();
  const [range, setRange] = useState(RANGES[0]);
  const [to, setTo] = useState(() => Date.now());
  const from = to - range.ms;
  const device = devices?.find((d) => d.ieeeAddress === ieee);
  // Refresh the charts when this unit reports something new.
  useEffect(() => setTo(Date.now()), [range, device?.lastSeen]);
  const { data: attributes } = useData(() => api.attributes(ieee), [ieee, device?.lastSeen]);
  const { data: presses } = useData(() => api.buttons({ ieee, limit: 15 }), [ieee, buttonTick]);

  const onOffAttrs = (attributes ?? []).filter((a) => /^state(_.+)?$/.test(a.attribute) && a.kind === 'text').map((a) => a.attribute);
  const numericAttrs = (attributes ?? []).filter((a) => a.kind === 'number').map((a) => a.attribute);
  const mainCharts = numericAttrs.filter((a) => /^(power|current|brightness|battery)(_.+)?$/.test(a));
  const otherNumeric = numericAttrs.filter((a) => !mainCharts.includes(a));
  const [extra, setExtra] = useState('');

  const wanted = useMemo(() => [...onOffAttrs, ...mainCharts, ...(extra ? [extra] : [])], [attributes, extra]);
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  useEffect(() => {
    let alive = true;
    Promise.all(wanted.map((a) => api.history(ieee, a, new Date(from), new Date(to)).then((h) => [a, h] as const))).then((entries) => {
      if (alive) setHistory(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [ieee, wanted.join(','), from, to]);

  if (!devices) return <p className="muted">Loading…</p>;
  if (!device) return <p>Unit not found. <a href="#/">Back to overview</a></p>;

  const stateEntries = Object.entries(device.state).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <a href="#/" className="back">← Overview</a>
      <section className="unit-hero">
        <span className="hero-icon" aria-hidden>{CATEGORY_ICON[device.category] ?? '🔌'}</span>
        <div className="hero-text">
          <h1>{device.name}</h1>
          <div className="muted">
            {CATEGORY_LABEL[device.category] ?? device.category}
            {device.room ? ` · ${device.room}` : ''}
            {device.availability ? ` · ${device.availability}` : ''}
            {device.lastSeen ? ` · updated ${fmtAgo(device.lastSeen)}` : ''}
          </div>
          {device.notes && <p className="notes">{device.notes}</p>}
        </div>
        <a className="button" href={link('names', device.ieeeAddress)}>Edit name</a>
      </section>

      {device.functions.length > 0 && (
        <section className="card">
          <h2>Parts of this unit</h2>
          <table className="table">
            <thead>
              <tr><th>Part</th><th>Name</th><th>Now</th><th>Channel</th></tr>
            </thead>
            <tbody>
              {device.functions.map((f) => (
                <tr key={f.channel}>
                  <td><span aria-hidden>{ROLE_ICON[f.role] ?? '🔌'} </span>{f.label}</td>
                  <td>{f.name}</td>
                  <td>
                    {f.role === 'button' || f.role === 'doorbell_button'
                      ? f.lastPress ? `${f.lastPress.name ?? f.lastPress.action} · ${fmtAgo(f.lastPress.ts)}` : 'no press yet'
                      : f.role === 'buzzer' ? 'listen-only'
                      : f.on === null ? '—' : f.on ? 'On' : 'Off'}
                  </td>
                  <td><code>{f.channel}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="now">
        {device.switches.map((s) => (
          <div key={s.channel} className="now-item">
            <div className="tile-label">{s.channel ? channelLabel(s.channel) : 'State'}</div>
            <div className={`now-value ${s.on ? 'text-on' : ''}`}>{s.on ? 'On' : 'Off'}</div>
          </div>
        ))}
        {device.powerW !== null && (
          <div className="now-item">
            <div className="tile-label">Power</div>
            <div className="now-value">{fmtWatts(device.powerW, device.powerEstimated)}</div>
          </div>
        )}
        {device.battery !== null && (
          <div className="now-item">
            <div className="tile-label">Battery</div>
            <div className={`now-value ${device.battery < 15 ? 'text-critical' : ''}`}>{device.battery}%</div>
          </div>
        )}
        {device.alerts.map((a) => (
          <div key={a} className="now-item status-critical">
            <div className="tile-label">Alert</div>
            <div className="now-value"><span aria-hidden>▲ </span>{a}</div>
          </div>
        ))}
      </section>

      <div className="range-row">
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} className={r.key === range.key ? 'active' : ''} onClick={() => setRange(r)}>
              {r.label}
            </button>
          ))}
        </div>
        {otherNumeric.length > 0 && (
          <select value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Show another value">
            <option value="">Show another value…</option>
            {otherNumeric.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}
      </div>

      {onOffAttrs.length > 0 && (
        <section className="card">
          <h2>On / off</h2>
          <OnOffChart
            from={from}
            to={to}
            rows={onOffAttrs.map((a) => ({
              label: a === 'state' ? 'State' : channelLabel(a.replace(/^state_/, '')),
              points: (history[a] ?? []).map((p) => ({ t: new Date(p.ts).getTime(), on: p.value === 'ON' })),
            }))}
          />
        </section>
      )}

      {[...mainCharts, ...(extra ? [extra] : [])].map((attr) => {
        const base = attr.replace(/_.*$/, '');
        const suffix = attr.includes('_') ? ` · ${channelLabel(attr.replace(/^[^_]+_/, ''))}` : '';
        return (
          <section key={attr} className="card">
            <h2>
              {(CHART_TITLE[base] ?? attr) + suffix}
              {base === 'current' && <span className="hint"> · the box reports amps; power is estimated from this</span>}
            </h2>
            <StepChart
              label={`${attr} over time`}
              from={from}
              to={to}
              format={formatFor(attr)}
              axisFormat={axisFor(attr)}
              points={(history[attr] ?? [])
                .filter((p) => typeof p.value === 'number')
                .map((p) => ({ t: new Date(p.ts).getTime(), v: toDisplay(attr, p.value as number) }))}
            />
          </section>
        );
      })}

      {wanted.length === 0 && attributes && (
        <section className="card empty">
          <p>No history for this unit yet. It appears once the unit reports a change.</p>
        </section>
      )}

      {(device.category === 'wall_switch' || device.category === 'doorbell' || (presses && presses.length > 0)) && (
        <section className="card">
          <h2>Recent presses</h2>
          {presses && presses.length > 0 ? (
            <table className="table">
              <thead>
                <tr><th>Time</th><th>Action</th><th>Channel</th></tr>
              </thead>
              <tbody>
                {presses.map((p) => (
                  <tr key={p.id}><td>{fmtTime(p.ts)}</td><td>{p.action_name ? <>{p.action_name} <code className="muted small">{p.action}</code></> : <code>{p.action}</code>}</td><td>{p.channel ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No presses recorded yet.</p>
          )}
        </section>
      )}

      <div className="two-col">
        <section className="card">
          <h2>Current values</h2>
          {stateEntries.length ? (
            <table className="table">
              <thead>
                <tr><th>Value</th><th>Now</th><th>Reported</th></tr>
              </thead>
              <tbody>
                {stateEntries.map(([k, v]) => (
                  <tr key={k}>
                    <td><code>{k}</code></td>
                    <td>{fmtValue(v)}</td>
                    <td className="muted">{fmtTime(device.attributeUpdated[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Nothing reported yet.</p>
          )}
        </section>
        <section className="card">
          <h2>About this unit</h2>
          <dl className="facts">
            <dt>Name on the box</dt><dd><code>{device.friendlyName}</code></dd>
            <dt>Hardware address</dt><dd><code>{device.ieeeAddress}</code></dd>
            <dt>Model</dt><dd>{[device.vendor, device.model].filter(Boolean).join(' ') || '—'}</dd>
            <dt>Description</dt><dd>{device.description ?? '—'}</dd>
            <dt>Power source</dt><dd>{device.powerSource ?? '—'}</dd>
            <dt>Zigbee role</dt><dd>{device.zigbeeType ?? '—'}</dd>
            <dt>First seen</dt><dd>{fmtDateTime(device.firstSeen)}</dd>
            {device.removed && (<><dt>Status</dt><dd className="text-critical">No longer in the box's device list</dd></>)}
          </dl>
        </section>
      </div>
    </>
  );
}
