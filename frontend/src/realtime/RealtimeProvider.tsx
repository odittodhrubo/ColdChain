import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth/AuthProvider';
import { applyRealtimeEvent, POLLED_KEYS, REALTIME_EVENTS } from './merge';

export type Connection = 'connecting' | 'live' | 'polling';

/** The part of a Socket.IO client this provider uses (tests pass a fake). */
export interface SocketLike {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  disconnect(): unknown;
}
export type Connect = (token: string) => SocketLike;

const defaultConnect: Connect = (token) =>
  io({ auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });

export const POLL_MS = 5000;

const RealtimeContext = createContext<Connection>('connecting');

/**
 * One Socket.IO connection per signed-in session, authenticated with the JWT. It is opened again whenever the
 * token changes (re-login after expiry), so the UI never looks live while it is stale. While the socket is
 * down the data is refreshed every 5 s instead, and the top bar says so.
 */
export function RealtimeProvider({
  children,
  connect = defaultConnect,
}: {
  children: ReactNode;
  connect?: Connect;
}) {
  const { token } = useAuth();
  const qc = useQueryClient();
  // status belongs to one token: a new session starts at 'connecting' without a reset effect
  const [state, setState] = useState<{ token: string | null; status: Connection }>({
    token: null,
    status: 'connecting',
  });
  const status: Connection = state.token === token ? state.status : 'connecting';

  useEffect(() => {
    if (!token) return;
    const socket = connect(token);
    const set = (s: Connection) => () => setState({ token, status: s });
    socket.on('connect', set('live'));
    socket.on('disconnect', set('polling'));
    socket.on('connect_error', set('polling'));
    for (const event of REALTIME_EVENTS) socket.on(event, (data) => applyRealtimeEvent(qc, event, data));
    return () => {
      socket.disconnect();
    };
  }, [token, connect, qc]);

  useEffect(() => {
    if (!token || status === 'live') return;
    const timer = setInterval(() => {
      void qc.invalidateQueries({
        predicate: (q) => POLLED_KEYS.includes(String(q.queryKey[0])),
        refetchType: 'active',
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [token, status, qc]);

  return <RealtimeContext.Provider value={status}>{children}</RealtimeContext.Provider>;
}

export const useConnection = () => useContext(RealtimeContext);
