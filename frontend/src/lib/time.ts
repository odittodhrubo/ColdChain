import { useEffect, useState } from 'react';
import type { StringKey } from '../i18n';

// Timers ("open for 01:12", "last seen 8 s ago") derive from server timestamps, never from when the browser
// happened to receive an update. The offset between the server clock and this browser's is learned from
// every response that carries server_time.

let offsetMs = 0;
export const setServerTime = (serverMs: number) => {
  offsetMs = serverMs - Date.now();
};
export const serverNow = () => Date.now() + offsetMs;

/** Re-renders every `everyMs` and returns the current server time (ms). */
export function useServerNow(everyMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export const mmss = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
};

/** "8 s ago" / "3 min ago" / "2 h ago". Pass a translator to localise it; English otherwise. */
export const ago = (seconds: number, t?: (k: StringKey) => string) => {
  const s = Math.max(0, Math.round(seconds));
  const [key, n]: ['time.sAgo' | 'time.minAgo' | 'time.hAgo', number] =
    s < 60 ? ['time.sAgo', s] : s < 3600 ? ['time.minAgo', Math.floor(s / 60)] : ['time.hAgo', Math.floor(s / 3600)];
  const en = { 'time.sAgo': '{n} s ago', 'time.minAgo': '{n} min ago', 'time.hAgo': '{n} h ago' };
  return (t ? t(key) : en[key]).replace('{n}', String(n));
};

export const clock = (unixS: number) =>
  new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
