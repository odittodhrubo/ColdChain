import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { readCookie, SESSION_COOKIE } from '../auth/session';
import { isRevoked, verifyToken } from '../auth/tokens';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';

// Server -> browser push (contract section 7: fridge:update, alert:new, ...; plus security:event).
export interface Realtime {
  emit(event: string, data: unknown): void;
  disconnectAll?(): void; // shutdown: open sockets would otherwise keep the HTTP server from closing
}

export const silentRealtime: Realtime = { emit: () => undefined };

/** Records emitted events (tests). */
export class RecordingRealtime implements Realtime {
  events: { event: string; data: unknown }[] = [];
  emit(event: string, data: unknown) {
    this.events.push({ event, data });
  }
  of(event: string) {
    return this.events.filter((e) => e.event === event).map((e) => e.data);
  }
}

/**
 * Socket.IO on the HTTP server, with the same session as the REST API: the browser's HttpOnly cookie (S1), or
 * `io(url, {auth: {token}})` from scripts. The token is verified, checked against revocations and a later
 * password change, and the user must be active. A cookie handshake must come from the app's own origin:
 * WebSockets are not covered by CORS, so this stops cross-site WebSocket hijacking (SameSite=Strict too).
 * Every authenticated role may receive the live feed (dashboard:read covers all three).
 */
export function attachSocketIO(server: HttpServer, ctx: AppContext): Realtime {
  const io = new Server(server, { cors: { origin: ctx.config.CORS_ORIGIN }, serveClient: false });
  const user = ctx.db.prepare('SELECT password_changed_at FROM users WHERE id = ? AND active = 1');
  const appOrigin = new URL(ctx.config.CORS_ORIGIN).origin;
  io.use((socket, next) => {
    try {
      const bearer = socket.handshake.auth?.token;
      const cookie = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      if (!bearer && cookie && socket.handshake.headers.origin !== appOrigin)
        return next(new Error('unauthorized'));
      const claims = verifyToken(String(bearer ?? cookie ?? ''), ctx.config);
      const row = user.get(Number(claims.sub)) as { password_changed_at: number } | undefined;
      if (isRevoked(ctx.db, claims.jti) || !row || claims.iat < row.password_changed_at)
        return next(new Error('unauthorized'));
      socket.data.userId = Number(claims.sub);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => logger.debug({ user: socket.data.userId }, 'realtime client connected'));
  return {
    emit: (event, data) => void io.emit(event, data),
    disconnectAll: () => io.disconnectSockets(true),
  };
}
