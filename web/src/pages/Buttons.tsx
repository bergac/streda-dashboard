import React, { useEffect, useState } from 'react';
import { api, type ButtonEvent, type Device } from '../api.ts';
import { link, useApp } from '../context.ts';
import { fmtDateTime } from '../format.ts';

/** The name of the button that was pressed when the unit has several, else the unit's name. */
function functionName(devices: Device[] | null, e: ButtonEvent): string {
  const f = devices?.find((d) => d.ieeeAddress === e.ieee_address)?.functions.find((x) => x.channel === e.channel);
  return f ? f.name : e.name;
}

export function ButtonsPage() {
  const { devices, buttonTick } = useApp();
  const [ieee, setIeee] = useState('');
  const [events, setEvents] = useState<ButtonEvent[] | null>(null);
  const [more, setMore] = useState(true);

  useEffect(() => {
    api.buttons({ limit: 100, ieee: ieee || undefined }).then((e) => {
      setEvents(e);
      setMore(e.length === 100);
    });
  }, [ieee, buttonTick]);

  const loadMore = async () => {
    if (!events?.length) return;
    const older = await api.buttons({ limit: 100, ieee: ieee || undefined, before: events[events.length - 1].ts });
    setEvents([...events, ...older]);
    setMore(older.length === 100);
  };

  const buttonUnits = (devices ?? []).filter((d) => ['wall_switch', 'doorbell'].includes(d.category) || d.state.action !== undefined);

  return (
    <>
      <h1>Button presses</h1>
      <p className="muted">Every press on a wireless switch or the doorbell. Useful when you set up automations later.</p>
      <div className="range-row">
        <select value={ieee} onChange={(e) => setIeee(e.target.value)} aria-label="Filter by unit">
          <option value="">All units</option>
          {buttonUnits.map((d) => (
            <option key={d.ieeeAddress} value={d.ieeeAddress}>{d.name}</option>
          ))}
        </select>
      </div>
      <section className="card">
        {!events ? (
          <p className="muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="muted">No presses recorded yet. Press a wireless switch and it shows up here right away.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Unit</th><th>Room</th><th>Action</th><th>Channel</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDateTime(e.ts)}</td>
                  <td><a href={link('unit', e.ieee_address)}>{functionName(devices, e)}</a></td>
                  <td>{e.room ?? '—'}</td>
                  <td>{e.action_name ? <>{e.action_name} <code className="muted small">{e.action}</code></> : <code>{e.action}</code>}</td>
                  <td>{e.channel ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {events && events.length > 0 && more && <button className="button" onClick={loadMore}>Load older presses</button>}
      </section>
    </>
  );
}
