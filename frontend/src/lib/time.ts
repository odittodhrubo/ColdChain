import { useEffect, useState } from 'react';

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

export const ago = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
};

export const clock = (unixS: number) =>
  new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
