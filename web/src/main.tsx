import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, useLive, type CollectorStatus, type Device, type LiveEvent } from './api.ts';
import { fmtAgo } from './format.ts';
import { AppContext } from './context.ts';
import { Overview } from './pages/Overview.tsx';
import { UnitPage } from './pages/Unit.tsx';
import { EnergyPage } from './pages/Energy.tsx';
import { ButtonsPage } from './pages/Buttons.tsx';
import { NamesPage } from './pages/Names.tsx';
import { SystemPage } from './pages/System.tsx';

function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function App() {
  const route = useRoute();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [buttonTick, setButtonTick] = useState(0);
  const [, setNow] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  const reloadDevices = useCallback(() => {
    api.devices().then(setDevices).catch(() => {});
  }, []);
  const scheduleReload = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(reloadDevices, 400);
  }, [reloadDevices]);

  useEffect(() => {
    reloadDevices();
    api.status().then((s) => (setStatus(s.collector), setLastMessageAt(s.collector.lastMessageAt))).catch(() => {});
    const tick = window.setInterval(() => setNow((n) => n + 1), 30_000); // refresh "x min ago"
    return () => window.clearInterval(tick);
  }, [reloadDevices]);

  const liveOpen = useLive((e: LiveEvent) => {
    if (e.type === 'status') {
      setStatus(e.status);
      if (e.status.lastMessageAt) setLastMessageAt(e.status.lastMessageAt);
      return;
    }
    setLastMessageAt(new Date().toISOString());
    if (e.type === 'button') setButtonTick((n) => n + 1);
    scheduleReload();
  });

  let page: React.ReactNode;
  switch (route[0]) {
    case 'unit':
      page = <UnitPage ieee={route[1]} />;
      break;
    case 'energy':
      page = <EnergyPage />;
      break;
    case 'buttons':
      page = <ButtonsPage />;
      break;
    case 'names':
      page = <NamesPage focus={route[1]} />;
      break;
    case 'system':
      page = <SystemPage />;
      break;
    default:
      page = <Overview />;
  }

  const nav = [
    ['', 'Overview'],
    ['energy', 'Energy'],
    ['buttons', 'Buttons'],
    ['names', 'Names'],
    ['system', 'System'],
  ];
  const current = route[0] === 'unit' ? '' : route[0] ?? '';

  return (
    <AppContext.Provider value={{ devices, status, lastMessageAt, reloadDevices, buttonTick, liveOpen }}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>⚡</span> Streda
        </div>
        <nav>
          {nav.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={current === key ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <ConnectionBadge status={status} liveOpen={liveOpen} lastMessageAt={lastMessageAt} />
      </header>
      <main>{page}</main>
      <footer className="foot">Listen-only: this dashboard reads from your Streda box and never sends commands to it.</footer>
    </AppContext.Provider>
  );
}

function ConnectionBadge({ status, liveOpen, lastMessageAt }: { status: CollectorStatus | null; liveOpen: boolean; lastMessageAt: string | null }) {
  let kind = 'warn';
  let text = 'Connecting…';
  if (!liveOpen) {
    kind = 'bad';
    text = 'Dashboard offline';
  } else if (status?.mqtt === 'connected') {
    kind = status.bridgeState === 'offline' ? 'warn' : 'good';
    text = status.bridgeState === 'offline' ? 'Box radio offline' : `Listening · ${fmtAgo(lastMessageAt)}`;
  } else if (status?.mqtt === 'disconnected') {
    kind = 'bad';
    text = 'Box not reachable';
  }
  return (
    <a href="#/system" className={`badge badge-${kind}`} title={status?.lastError ?? status?.host ?? ''}>
      <span className="badge-icon" aria-hidden>{kind === 'good' ? '●' : kind === 'warn' ? '▲' : '✕'}</span>
      {text}
    </a>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
