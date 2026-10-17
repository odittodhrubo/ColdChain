import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { isRevoked, verifyToken } from '../auth/tokens';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';

// Server -> browser push (contract section 7: fridge:update, alert:new, ...; plus security:event).
export interface Realtime {
  emit(event: string, data: unknown): void;
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
 * Socket.IO on the HTTP server. Clients authenticate with the same JWT as the REST API
 * (`io(url, {auth: {token}})`); the token is verified, checked against revocations, and the user must be active.
 * Every authenticated role may receive the live feed (dashboard:read covers all three).
 */
export function attachSocketIO(server: HttpServer, ctx: AppContext): Realtime {
  const io = new Server(server, { cors: { origin: ctx.config.CORS_ORIGIN }, serveClient: false });
  const active = ctx.db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1');
  io.use((socket, next) => {
    try {
      const claims = verifyToken(String(socket.handshake.auth?.token ?? ''), ctx.config);
      if (isRevoked(ctx.db, claims.jti) || !active.get(Number(claims.sub)))
        return next(new Error('unauthorized'));
      socket.data.userId = Number(claims.sub);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => logger.debug({ user: socket.data.userId }, 'realtime client connected'));
  return { emit: (event, data) => void io.emit(event, data) };
}
