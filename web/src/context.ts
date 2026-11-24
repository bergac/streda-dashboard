import { createContext, useContext } from 'react';
import type { CollectorStatus, Device } from './api.ts';

export interface AppData {
  devices: Device[] | null;
  status: CollectorStatus | null;
  lastMessageAt: string | null;
  reloadDevices: () => void;
  /** Increments on every button press, so pages can refresh. */
  buttonTick: number;
  liveOpen: boolean;
}

export const AppContext = createContext<AppData>(null as any);
export const useApp = () => useContext(AppContext);
export const link = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;
