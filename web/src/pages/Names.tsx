import React, { useEffect, useRef, useState } from 'react';
import { api, useData, type ButtonAction, type Device, type DeviceFunction } from '../api.ts';
import { link, useApp } from '../context.ts';
import { CATEGORY_ICON, CATEGORY_LABEL, ROLE_ICON, fmtAgo } from '../format.ts';

export function NamesPage({ focus }: { focus?: string }) {
  const { devices, reloadDevices } = useApp();
  const { data: rooms, reload: reloadRooms } = useData(() => api.rooms(), []);
  const [filter, setFilter] = useState<'all' | 'unnamed'>('all');

  if (!devices) return <p className="muted">Loading…</p>;
  const list = devices
    .filter((d) => d.category !== 'coordinator')
    .filter((d) => filter === 'all' || !d.displayName)
    .sort((a, b) => Number(a.removed) - Number(b.removed) || a.friendlyName.localeCompare(b.friendlyName, undefined, { numeric: true }));

  return (
    <>
      <h1>Names and rooms</h1>
      <p className="muted">
        Give each unit a name you recognise and put it in a room. Names are stored in your own database only; nothing changes on the
        Streda box. New units appear here automatically. Tip: switch a light on or off and see which unit updates "just now".
      </p>
      <div className="range-row">
        <div className="segmented" role="group" aria-label="Filter">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All units</button>
          <button className={filter === 'unnamed' ? 'active' : ''} onClick={() => setFilter('unnamed')}>Not named yet</button>
        </div>
      </div>
      <datalist id="rooms">
        {(rooms ?? []).map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <section className="names">
        {list.map((d) => (
          <React.Fragment key={d.ieeeAddress}>
            <NameRow d={d} focused={focus === d.ieeeAddress} onSaved={() => (reloadDevices(), reloadRooms())} />
            {d.functions.map((f) => (
              <FunctionRow key={f.channel} d={d} f={f} onSaved={() => (reloadDevices(), reloadRooms())} />
            ))}
          </React.Fragment>
        ))}
        {list.length === 0 && <p className="muted">Nothing to show.</p>}
      </section>
    </>
  );
}

function NameRow({ d, focused, onSaved }: { d: Device; focused: boolean; onSaved: () => void }) {
  const { buttonTick } = useApp();
  const initial = { displayName: d.displayName ?? '', room: d.room ?? '', notes: d.notes ?? '', hidden: d.hidden };
  const [form, setForm] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ block: 'center' });
      ref.current?.querySelector('input')?.focus();
    }
  }, [focused]);

  // Pick up changes saved elsewhere (another browser) unless the user is typing here.
  useEffect(() => {
    if (!dirty) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.displayName, d.room, d.notes, d.hidden]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('saving');
    try {
      await api.saveLabel(d.ieeeAddress, form);
      setState('saved');
      onSaved();
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setState('error');
      setError((err as Error).message);
    }
  };

  const { data: actions, reload: reloadActions } = useData(() => api.buttonActions(d.ieeeAddress), [d.ieeeAddress, buttonTick]);

  const summary = d.switches.length
    ? d.switches.map((s) => `${s.channel || 'state'} ${s.on ? 'on' : 'off'}`).join(', ')
    : d.battery !== null
      ? `battery ${d.battery}%`
      : '';

  return (
    <form ref={ref} className={`name-row ${focused ? 'focused' : ''} ${d.removed ? 'removed' : ''}`} onSubmit={save}>
      <div className="name-id">
        <span className="unit-icon" aria-hidden>{CATEGORY_ICON[d.category] ?? '🔌'}</span>
        <div>
          <a href={link('unit', d.ieeeAddress)} className="name-box"><code>{d.friendlyName}</code></a>
          <div className="muted small">
            {CATEGORY_LABEL[d.category] ?? d.category}
            {d.model ? ` · ${d.model}` : ''} · {d.lastSeen ? `updated ${fmtAgo(d.lastSeen)}` : 'not heard from yet'}
            {summary ? ` · ${summary}` : ''}
            {d.removed ? ' · removed from the box' : ''}
          </div>
        </div>
      </div>
      <label>
        <span>Name</span>
        <input value={form.displayName} maxLength={100} placeholder="e.g. Kitchen ceiling light" onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </label>
      <label>
        <span>Room</span>
        <input value={form.room} maxLength={60} list="rooms" placeholder="e.g. Kitchen" onChange={(e) => setForm({ ...form, room: e.target.value })} />
      </label>
      <label className="wide">
        <span>Notes</span>
        <input value={form.notes} maxLength={1000} placeholder="optional" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
      {d.functions.length === 0 && actions && actions.length > 0 && <ActionNames ieee={d.ieeeAddress} actions={actions} onSaved={reloadActions} />}
      <label className="check">
        <input type="checkbox" checked={form.hidden} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} /> Hide on overview
      </label>
      <div className="name-actions">
        <button className="button primary" disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state === 'saved' && <span className="text-good">✓ Saved</span>}
        {state === 'error' && <span className="text-critical">▲ {error}</span>}
      </div>
    </form>
  );
}

/** One function (a button, the buzzer, a socket, a light) of a unit that has several. Empty name and room fall back to the unit's. */
function FunctionRow({ d, f, onSaved }: { d: Device; f: DeviceFunction; onSaved: () => void }) {
  const { buttonTick } = useApp();
  const initial = { displayName: f.named ? f.name : '', room: f.room && f.room !== d.room ? f.room : '', notes: f.notes ?? '', hidden: f.hidden && !d.hidden };
  const [form, setForm] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    if (!dirty) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.name, f.named, f.room, f.notes, f.hidden]);

  const isButton = f.role === 'button' || f.role === 'doorbell_button';
  const { data: allActions, reload: reloadActions } = useData(() => (isButton ? api.buttonActions(d.ieeeAddress) : Promise.resolve([])), [d.ieeeAddress, isButton, buttonTick]);
  const actions = (allActions ?? []).filter((a) => a.action.endsWith(`_${f.channel}`));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('saving');
    try {
      await api.saveFunctionLabel(d.ieeeAddress, f.channel, form);
      setState('saved');
      onSaved();
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setState('error');
      setError((err as Error).message);
    }
  };

  return (
    <form className="name-row" style={{ marginLeft: '2rem' }} onSubmit={save}>
      <div className="name-id">
        <span className="unit-icon" aria-hidden>{ROLE_ICON[f.role] ?? '🔌'}</span>
        <div>
          <div className="name-box">{f.label}</div>
          <div className="muted small">
            part of <code>{d.friendlyName}</code> · channel <code>{f.channel}</code>
            {f.role === 'buzzer' ? ' · listen-only, reports nothing' : ''}
          </div>
        </div>
      </div>
      <label>
        <span>Name</span>
        <input value={form.displayName} maxLength={100} placeholder={`${d.name} · ${f.label}`} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </label>
      <label>
        <span>Room</span>
        <input value={form.room} maxLength={60} list="rooms" placeholder={d.room ?? 'same as the unit'} onChange={(e) => setForm({ ...form, room: e.target.value })} />
      </label>
      <label className="wide">
        <span>Notes</span>
        <input value={form.notes} maxLength={1000} placeholder="optional" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
      {actions.length > 0 && <ActionNames ieee={d.ieeeAddress} actions={actions} onSaved={reloadActions} />}
      <label className="check">
        <input type="checkbox" checked={form.hidden} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} /> Hide on overview
      </label>
      <div className="name-actions">
        <button className="button primary" disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state === 'saved' && <span className="text-good">✓ Saved</span>}
        {state === 'error' && <span className="text-critical">▲ {error}</span>}
      </div>
    </form>
  );
}

/** Names for the separate actions of a wireless switch. Saved on their own, so it is not a form inside the unit's form. */
function ActionNames({ ieee, actions, onSaved }: { ieee: string; actions: ButtonAction[]; onSaved: () => void }) {
  const saved = Object.fromEntries(actions.map((a) => [a.action, a.name ?? '']));
  const [form, setForm] = useState<Record<string, string>>(saved);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const dirty = actions.some((a) => (form[a.action] ?? '') !== saved[a.action]);

  // A new action may show up (a press) or be named elsewhere; keep what is being typed.
  useEffect(() => {
    setForm((f) => ({ ...saved, ...(dirty ? f : {}) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved)]);

  const save = async () => {
    setState('saving');
    try {
      await api.saveButtonActions(ieee, form);
      setState('saved');
      onSaved();
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setState('error');
      setError((err as Error).message);
    }
  };

  return (
    <fieldset className="wide action-names">
      <legend className="muted small">Button actions. Name each one; the name is shown instead of the action code.</legend>
      {actions.map((a) => (
        <label key={a.action}>
          <span><code>{a.action}</code></span>
          <input
            value={form[a.action] ?? ''}
            maxLength={100}
            placeholder="e.g. Hallway light on"
            onChange={(e) => setForm({ ...form, [a.action]: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), dirty && save())}
          />
        </label>
      ))}
      <button type="button" className="button" disabled={!dirty || state === 'saving'} onClick={save}>
        {state === 'saving' ? 'Saving…' : 'Save action names'}
      </button>
      {state === 'saved' && <span className="text-good"> ✓ Saved</span>}
      {state === 'error' && <span className="text-critical"> ▲ {error}</span>}
    </fieldset>
  );
}
