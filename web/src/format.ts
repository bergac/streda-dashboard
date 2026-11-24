const LOCALE = 'en-GB';

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

export function fmtWatts(w: number | null, estimated = false): string {
  if (w === null) return '—';
  const v = w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${w < 10 ? w.toFixed(1) : Math.round(w)} W`;
  return estimated ? `≈ ${v}` : v;
}

export function fmtEnergy(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(wh >= 10000 ? 1 : 2)} kWh`;
  return `${Math.round(wh)} Wh`;
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const CATEGORY_LABEL: Record<string, string> = {
  relay: 'Light / relay',
  dimmer: 'Dimmer',
  wall_switch: 'Wall switch',
  doorbell: 'Doorbell',
  smoke_detector: 'Smoke detector',
  coordinator: 'Control box radio',
  other: 'Other',
};

export const CATEGORY_ICON: Record<string, string> = {
  relay: '💡',
  dimmer: '🔆',
  wall_switch: '🔘',
  doorbell: '🔔',
  smoke_detector: '🚨',
  coordinator: '📡',
  other: '🔌',
};

export const ROLE_ICON: Record<string, string> = {
  light: '💡',
  socket: '🔌',
  dimmer: '🔆',
  button: '🔘',
  buzzer: '🔔',
  doorbell_button: '🛎️',
};

export function channelLabel(channel: string): string {
  if (!channel) return '';
  const m = channel.match(/^l(\d+)$/i);
  return m ? `Channel ${m[1]}` : channel;
}

/** Short labels for chart axes (no needless decimals). */
export function fmtEnergyAxis(wh: number): string {
  return wh >= 1000 ? `${Number((wh / 1000).toFixed(2))} kWh` : `${Math.round(wh)} Wh`;
}
export function fmtAxis(unit: string) {
  return (v: number) => `${Number(v.toFixed(2))}${unit}`;
}
