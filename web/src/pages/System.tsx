import React, { useState } from 'react';
import { api, useData } from '../api.ts';
import { useApp } from '../context.ts';
import { fmtAgo, fmtDateTime, fmtDuration } from '../format.ts';

export function SystemPage() {
  const { status, liveOpen, lastMessageAt } = useApp();
  const { data: info } = useData(() => api.status(), [status?.mqtt]);
  const { data: sessions } = useData(() => api.sessions(), [status?.listeningSince]);
  const [topic, setTopic] = useState('');
  const { data: raw, reload } = useData(() => api.raw({ limit: 100, topic: topic || undefined }), [topic]);
  const [open, setOpen] = useState<number | null>(null);

  const mqttText =
    status?.mqtt === 'connected' ? 'Connected and listening' : status?.mqtt === 'disconnected' ? 'Not connected (retrying)' : 'Connecting…';

  return (
    <>
      <h1>System</h1>
      <div className="two-col">
        <section className="card">
          <h2>Connection to the Streda box</h2>
          <dl className="facts">
            <dt>Box address</dt><dd><code>{status?.host ?? '—'}</code></dd>
            <dt>Status</dt>
            <dd className={status?.mqtt === 'connected' ? 'text-good' : 'text-critical'}>
              <span aria-hidden>{status?.mqtt === 'connected' ? '● ' : '▲ '}</span>{mqttText}
            </dd>
            {status?.lastError && status.mqtt !== 'connected' && (<><dt>Last problem</dt><dd>{status.lastError}</dd></>)}
            <dt>Zigbee radio in the box</dt><dd>{status?.bridgeState ?? 'unknown'}</dd>
            <dt>Listening since</dt><dd>{status?.listeningSince ? fmtDateTime(status.listeningSince) : '—'}</dd>
            <dt>Last message</dt><dd>{lastMessageAt ? `${fmtDateTime(lastMessageAt)} (${fmtAgo(lastMessageAt)})` : '—'}</dd>
            <dt>Live updates in this browser</dt><dd>{liveOpen ? 'on' : 'off (reconnecting)'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Database</h2>
          <dl className="facts">
            <dt>Units</dt><dd>{info?.counts.devices ?? '—'}</dd>
            <dt>History values</dt><dd>{info?.counts.readings?.toLocaleString('en-GB') ?? '—'}</dd>
            <dt>Button presses</dt><dd>{info?.counts.button_events?.toLocaleString('en-GB') ?? '—'}</dd>
            <dt>Raw messages kept</dt><dd>{info?.counts.raw_messages?.toLocaleString('en-GB') ?? '—'}</dd>
            <dt>Time zone</dt><dd>{info?.timezone ?? '—'}</dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <h2>Listening periods</h2>
        <p className="hint">Energy is only counted inside these periods. Gaps are times when the computer was asleep, the app was stopped or the box was unreachable.</p>
        {sessions && sessions.length > 0 ? (
          <table className="table">
            <thead>
              <tr><th>From</th><th>Until</th><th className="num">Length</th><th>Ended because</th></tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const end = s.ended_at ?? s.last_heartbeat;
                return (
                  <tr key={s.id}>
                    <td>{fmtDateTime(s.started_at)}</td>
                    <td>{s.ended_at ? fmtDateTime(s.ended_at) : <span className="text-good">now</span>}</td>
                    <td className="num">{fmtDuration((s.ended_at ? new Date(end).getTime() : Date.now()) - new Date(s.started_at).getTime())}</td>
                    <td>{s.end_reason ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">No listening periods yet.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Raw messages from the box</h2>
          <div className="actions">
            <button className="button" onClick={reload}>Refresh</button>
            <a className="button" href="/api/raw?limit=20000&download=1">Download (JSON)</a>
          </div>
        </div>
        <p className="hint">Exactly what the box sent, kept for a limited time. Handy for checking what a unit reports, or for improving this dashboard.</p>
        <input className="search" placeholder="Filter by topic…" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <table className="table raw">
          <thead>
            <tr><th>Time</th><th>Topic</th><th>Message</th></tr>
          </thead>
          <tbody>
            {(raw ?? []).map((m) => (
              <tr key={m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                <td className="nowrap">{fmtDateTime(m.ts)}{m.retained && <span className="tag" title="Stored on the box and replayed when connecting">retained</span>}</td>
                <td><code>{m.topic}</code></td>
                <td>
                  {open === m.id ? <pre>{pretty(m.payload)}</pre> : <code className="clip">{m.payload.slice(0, 160)}</code>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
