import React, { useState } from 'react';
import type { Device, DeviceFunction } from '../api.ts';
import { useApp, link } from '../context.ts';
import { CATEGORY_ICON, CATEGORY_LABEL, ROLE_ICON, channelLabel, fmtAgo, fmtWatts } from '../format.ts';

type OnFilter = 'all' | 'on' | 'off';

/** One row in the list: a whole unit, or one function of a unit that has several. */
interface Row {
  key: string;
  device: Device;
  fn: DeviceFunction | null;
  room: string;
  type: string;
  /** null when on/off does not apply (buttons, sensors) or is not known yet. */
  on: boolean | null;
}

function toRow(d: Device, fn: DeviceFunction | null): Row {
  if (fn) {
    const isInput = fn.role === 'button' || fn.role === 'doorbell_button' || fn.role === 'buzzer';
    return { key: `${d.ieeeAddress}/${fn.channel}`, device: d, fn, room: fn.room ?? '', type: fn.label, on: isInput ? null : fn.on };
  }
  return {
    key: d.ieeeAddress,
    device: d,
    fn: null,
    room: d.room ?? '',
    type: CATEGORY_LABEL[d.category] ?? d.category,
    on: d.switches.length > 0 ? d.switches.some((x) => x.on) : null,
  };
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function Overview() {
  const { devices } = useApp();
  const [showHidden, setShowHidden] = useState(false);
  const [onFilter, setOnFilter] = useState<OnFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [roomFilter, setRoomFilter] = useState<string | null>(null);
  if (!devices) return <p className="muted">Loading…</p>;

  const visible = devices.filter((d) => !d.removed && d.category !== 'coordinator' && (showHidden || !d.hidden));
  const powered = visible.filter((d) => d.powerW !== null);
  const totalW = powered.reduce((s, d) => s + (d.powerW ?? 0), 0);
  const anyEstimated = powered.some((d) => d.powerEstimated);
  const alerts = visible.flatMap((d) => d.alerts.map((a) => ({ device: d, alert: a })));
  const unnamed = visible.filter((d) => !d.displayName).length;

  const rows: Row[] = visible.flatMap((d): Row[] =>
    d.functions.length === 0 ? [toRow(d, null)] : d.functions.filter((f) => showHidden || !f.hidden).map((f) => toRow(d, f)),
  );
  const allRooms = [...new Set(rows.map((r) => r.room))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : byText(a, b)));
  const allTypes = [...new Set(rows.map((r) => r.type))].sort(byText);

  // Filters that point at something that no longer exists simply stop applying.
  const activeRoom = roomFilter !== null && allRooms.includes(roomFilter) ? roomFilter : null;
  const activeTypes = typeFilter.filter((t) => allTypes.includes(t));
  const filtered = rows.filter(
    (r) =>
      (onFilter === 'all' || r.on === (onFilter === 'on')) &&
      (activeTypes.length === 0 || activeTypes.includes(r.type)) &&
      (activeRoom === null || r.room === activeRoom),
  );
  const filtering = onFilter !== 'all' || activeTypes.length > 0 || activeRoom !== null;

  // Group: room > unit > type > on/off (on first).
  const sorted = [...filtered].sort(
    (a, b) =>
      (a.room === '' ? 1 : b.room === '' ? -1 : byText(a.room, b.room)) ||
      byText(a.device.name, b.device.name) ||
      byText(a.type, b.type) ||
      Number(b.on === true) - Number(a.on === true) ||
      byText(a.fn?.name ?? '', b.fn?.name ?? ''),
  );
  const rooms: Array<{ room: string; units: Array<{ device: Device; rows: Row[] }>; count: number }> = [];
  for (const r of sorted) {
    let room = rooms[rooms.length - 1];
    if (!room || room.room !== r.room) rooms.push((room = { room: r.room, units: [], count: 0 }));
    let unit = room.units[room.units.length - 1];
    if (!unit || unit.device !== r.device) room.units.push((unit = { device: r.device, rows: [] }));
    unit.rows.push(r);
    room.count++;
  }

  const toggleType = (t: string) => setTypeFilter(activeTypes.includes(t) ? activeTypes.filter((x) => x !== t) : [...activeTypes, t]);
  const clearFilters = () => {
    setOnFilter('all');
    setTypeFilter([]);
    setRoomFilter(null);
  };

  return (
    <>
      <section className="tiles">
        <div className="tile">
          <div className="tile-label">Power right now</div>
          <div className="tile-value">{powered.length ? fmtWatts(totalW, anyEstimated) : '—'}</div>
          <div className="tile-sub">{powered.length ? `from ${powered.length} unit${powered.length === 1 ? '' : 's'} that report power${anyEstimated ? ' · partly estimated' : ''}` : 'no unit reports power yet'}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Units</div>
          <div className="tile-value">{visible.length}</div>
          <div className="tile-sub">
            {unnamed > 0 ? <a href="#/names">{unnamed} still need a name →</a> : 'all named'}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Alerts</div>
          <div className={`tile-value ${alerts.length ? 'text-critical' : ''}`}>{alerts.length}</div>
          <div className="tile-sub">{alerts.length ? 'see below' : 'nothing to report'}</div>
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="card alerts">
          <h2>Alerts</h2>
          <ul>
            {alerts.map(({ device, alert }) => (
              <li key={device.ieeeAddress + alert} className={alert.startsWith('Smoke') ? 'status-critical' : 'status-warning'}>
                <span className="status-icon" aria-hidden>{alert.startsWith('Smoke') ? '✕' : '▲'}</span>
                <strong>{alert}</strong> — <a href={link('unit', device.ieeeAddress)}>{device.name}</a>
                {device.room ? <span className="muted"> · {device.room}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {visible.length === 0 && (
        <section className="card empty">
          <h2>No units yet</h2>
          <p>As soon as the dashboard hears from your Streda box, its units appear here. Check the connection on the <a href="#/system">System</a> page.</p>
        </section>
      )}

      {rows.length > 0 && (
        <section className="filters" aria-label="Filter units">
          <div className="filter-row">
            <div className="segmented" role="group" aria-label="On or off">
              {(['all', 'on', 'off'] as const).map((v) => (
                <button key={v} type="button" className={onFilter === v ? 'active' : ''} aria-pressed={onFilter === v} onClick={() => setOnFilter(v)}>
                  {v === 'all' ? 'All' : v === 'on' ? 'On' : 'Off'}
                </button>
              ))}
            </div>
            <label className="filter-room">
              <span className="muted">Room</span>
              <select value={activeRoom ?? ''} onChange={(e) => setRoomFilter(e.target.value === '' ? null : e.target.value === NO_ROOM ? '' : e.target.value)}>
                <option value="">All rooms</option>
                {allRooms.map((r) => (
                  <option key={r || NO_ROOM} value={r || NO_ROOM}>{r || 'No room yet'}</option>
                ))}
              </select>
            </label>
            <span className="filter-count" role="status" aria-live="polite">
              <strong>{filtered.length}</strong> of {rows.length} {rows.length === 1 ? 'result' : 'results'}
              {filtering && (
                <>
                  {' · '}
                  <button type="button" className="link-button" onClick={clearFilters}>Clear filters</button>
                </>
              )}
            </span>
          </div>
          <div className="filter-row" role="group" aria-label="Type">
            <span className="muted">Type</span>
            {allTypes.map((t) => (
              <button key={t} type="button" className={`chip ${activeTypes.includes(t) ? 'active' : ''}`} aria-pressed={activeTypes.includes(t)} onClick={() => toggleType(t)}>
                {t}
              </button>
            ))}
          </div>
        </section>
      )}

      {rows.length > 0 && filtered.length === 0 && <p className="muted">No units match these filters.</p>}

      {rooms.map(({ room, units, count }) => (
        <section key={room || '-'} className="room">
          <h2>
            {room || 'No room yet'} <span className="room-count">{count}</span>
          </h2>
          <ul className="unit-list">
            {units.map(({ device, rows: unitRows }) =>
              unitRows.length === 1 ? (
                <li key={unitRows[0].key}>
                  <RowItem row={unitRows[0]} />
                </li>
              ) : (
                <li key={device.ieeeAddress} className="unit-group">
                  <div className="unit-group-head">{device.name}</div>
                  <ul>
                    {unitRows.map((r) => (
                      <li key={r.key}>
                        <RowItem row={r} grouped />
                      </li>
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}

      {devices.some((d) => d.hidden || d.functions.some((f) => f.hidden)) && (
        <label className="toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden units
        </label>
      )}
    </>
  );
}

const NO_ROOM = '__none__';

function RowItem({ row, grouped = false }: { row: Row; grouped?: boolean }) {
  return row.fn ? <FunctionRow d={row.device} f={row.fn} grouped={grouped} /> : <UnitRow d={row.device} />;
}

/** One function (a button, the buzzer, a socket, a light) of a unit with several. */
function FunctionRow({ d, f, grouped }: { d: Device; f: DeviceFunction; grouped: boolean }) {
  const offline = d.availability === 'offline';
  const isButton = f.role === 'button' || f.role === 'doorbell_button';
  return (
    <a className={`unit-row ${offline ? 'unit-offline' : ''}`} href={link('unit', d.ieeeAddress)}>
      <span className="unit-icon" aria-hidden>{ROLE_ICON[f.role] ?? '🔌'}</span>
      <div className="row-main">
        <div className="unit-name">{f.name}</div>
        <div className="unit-type">{grouped ? f.label : `${f.label} · part of ${d.name}`}</div>
      </div>
      <div className="row-state">
        {isButton ? (
          f.lastPress ? (
            <span className="pill pill-off">{f.lastPress.name ?? f.lastPress.action}</span>
          ) : (
            <span className="pill pill-unknown">No press yet</span>
          )
        ) : f.role === 'buzzer' ? (
          <span className="pill pill-unknown">Listen-only, no data</span>
        ) : f.on !== null ? (
          <span className={`pill ${f.on ? 'pill-on' : 'pill-off'}`}>{f.on ? 'On' : 'Off'}</span>
        ) : (
          <span className="pill pill-unknown">Not heard from yet</span>
        )}
        {f.brightness !== null && f.brightness > 0 && <span className="unit-stat">{Math.round((f.brightness / 254) * 100)}%</span>}
        {f.powerW !== null && <span className="unit-stat">{fmtWatts(f.powerW, f.powerEstimated)}</span>}
        {isButton && d.battery !== null && <span className={`unit-stat ${d.battery < 15 ? 'text-critical' : ''}`}>🔋 {d.battery}%</span>}
      </div>
      <div className="row-foot">
        {offline ? (
          <span className="text-critical">▲ Offline</span>
        ) : f.lastPress ? (
          <span className="muted">pressed {fmtAgo(f.lastPress.ts)}</span>
        ) : (
          <span className="muted">{d.lastSeen ? `unit updated ${fmtAgo(d.lastSeen)}` : 'no updates yet'}</span>
        )}
      </div>
    </a>
  );
}

function UnitRow({ d }: { d: Device }) {
  const offline = d.availability === 'offline';
  const updated = d.lastSeen;
  return (
    <a className={`unit-row ${offline ? 'unit-offline' : ''}`} href={link('unit', d.ieeeAddress)}>
      <span className="unit-icon" aria-hidden>{CATEGORY_ICON[d.category] ?? '🔌'}</span>
      <div className="row-main">
        <div className="unit-name">{d.name}</div>
        <div className="unit-type">{CATEGORY_LABEL[d.category] ?? d.category}</div>
      </div>
      <div className="row-state">
        {d.switches.length > 0 ? (
          d.switches.map((s) => (
            <span key={s.channel} className={`pill ${s.on ? 'pill-on' : 'pill-off'}`}>
              {s.channel && d.switches.length > 1 ? `${channelLabel(s.channel)}: ` : ''}
              {s.on ? 'On' : 'Off'}
            </span>
          ))
        ) : d.category === 'smoke_detector' ? (
          <span className={`pill ${d.state.smoke === true ? 'pill-alarm' : 'pill-off'}`}>{d.state.smoke === true ? 'SMOKE' : d.state.smoke === false ? 'No smoke' : 'Unknown'}</span>
        ) : Object.keys(d.state).length === 0 ? (
          <span className="pill pill-unknown">Not heard from yet</span>
        ) : null}
        {typeof d.state.brightness === 'number' && d.state.brightness > 0 && (
          <span className="unit-stat">{Math.round(((d.state.brightness as number) / 254) * 100)}%</span>
        )}
        {d.powerW !== null && <span className="unit-stat">{fmtWatts(d.powerW, d.powerEstimated)}</span>}
        {d.battery !== null && <span className={`unit-stat ${d.battery < 15 ? 'text-critical' : ''}`}>🔋 {d.battery}%</span>}
      </div>
      <div className="row-foot">
        {offline ? <span className="text-critical">▲ Offline</span> : <span className="muted">{updated ? `updated ${fmtAgo(updated)}` : 'no updates yet'}</span>}
      </div>
    </a>
  );
}
