import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { revoke, signToken } from '../src/auth/tokens';
import { attachSocketIO } from '../src/realtime';
import type { AppContext } from '../src/shared/http';
import { addUser, makeApp } from './helpers';

const sockets: Socket[] = [];
const servers: { close: () => void }[] = [];
afterEach(() => {
  sockets.splice(0).forEach((s) => s.close());
  servers.splice(0).forEach((s) => s.close());
});

async function start() {
  const t = makeApp();
  const server = t.app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const ctx = t.app.locals.ctx as AppContext;
  ctx.realtime = attachSocketIO(server, ctx);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (token?: string) => {
    const s = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return s;
  };
  return { t, ctx, client, url };
}

describe('Socket.IO realtime', () => {
  it('pushes events to clients with a valid JWT', async () => {
    const { t, ctx, client } = await start();
    const socket = client(signToken(await addUser(t, 'INSPECTOR'), t.config).token);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    const got = new Promise((r) => socket.on('fridge:update', r));
    ctx.realtime.emit('fridge:update', { fridge_id: 'fridge-01', temp: 4.6 });
    expect(await got).toEqual({ fridge_id: 'fridge-01', temp: 4.6 });
  });

  it('refuses missing, invalid and revoked tokens', async () => {
    const { t, client } = await start();
    const user = await addUser(t, 'ADMIN');
    const revoked = signToken(user, t.config);
    revoke(t.db, revoked.jti, revoked.exp);
    for (const token of [undefined, 'not-a-jwt', revoked.token]) {
      const err = await new Promise<Error>((resolve) => client(token).on('connect_error', resolve));
      expect(err.message).toBe('unauthorized');
    }
  });

  it('accepts the session cookie from the app origin only (S1)', async () => {
    const { t, url } = await start();
    const { token } = signToken(await addUser(t, 'INSPECTOR'), t.config);
    const withCookie = (origin: string) => {
      const s = connect(url, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { Cookie: `cc_session=${token}`, Origin: origin },
      });
      sockets.push(s);
      return new Promise<string>((resolve) => {
        s.on('connect', () => resolve('connected'));
        s.on('connect_error', (e) => resolve(e.message));
      });
    };
    expect(await withCookie(new URL(t.config.CORS_ORIGIN).origin)).toBe('connected');
    expect(await withCookie('https://evil.example')).toBe('unauthorized');
  });
});
