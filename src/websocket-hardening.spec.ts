import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';

vi.mock('./jwt-auth', () => ({ verifyEngineToken: vi.fn() }));
vi.mock('./redis', () => ({ getLiveSnapshot: vi.fn().mockResolvedValue({ mocked: true }) }));
vi.mock('./scheduler', () => ({ getRegisteredPluginIds: vi.fn().mockReturnValue(['plugin-1']) }));

import {
  handleConnection,
  createRateLimiter,
  isSubscriptionAllowed,
  WS_CLOSE_RATE_LIMIT,
  WS_CLOSE_NOT_IN_SCOPE,
} from './websocket';
import { verifyEngineToken } from './jwt-auth';

describe('createRateLimiter', () => {
  it('allows exactly `limit` calls inside one window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    expect([limiter.allow(), limiter.allow(), limiter.allow()]).toEqual([true, true, true]);
  });

  it('blocks the call after the limit', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    limiter.allow(); limiter.allow(); limiter.allow();
    expect(limiter.allow()).toBe(false);
  });

  it('allows again once the window has passed', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    clock = 1001;
    expect(limiter.allow()).toBe(true);
  });
});

describe('isSubscriptionAllowed', () => {
  it('allows any channel when the ticket carries no scope', () => {
    expect(isSubscriptionAllowed(undefined, 'earthquakes')).toBe(true);
  });

  it('allows any channel when the scope grants read', () => {
    expect(isSubscriptionAllowed('plugins:read', 'earthquakes')).toBe(true);
  });

  it('allows only the named channels when the scope names them', () => {
    expect(isSubscriptionAllowed('plugins:read:earthquakes', 'earthquakes')).toBe(true);
    expect(isSubscriptionAllowed('plugins:read:earthquakes', 'wildfire')).toBe(false);
  });

  it('allows several named channels in one scope', () => {
    const scope = 'plugins:read:earthquakes plugins:read:wildfire';
    expect(isSubscriptionAllowed(scope, 'wildfire')).toBe(true);
    expect(isSubscriptionAllowed(scope, 'marine-buoys')).toBe(false);
  });

  it('denies every channel when the scope is present but empty', () => {
    expect(isSubscriptionAllowed('', 'earthquakes')).toBe(false);
  });
});

describe('connection hardening (mocked verifyEngineToken)', () => {
  let app: FastifyInstance;
  let url: string;
  const mockVerify = verifyEngineToken as ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    delete process.env.WWV_SKIP_WS_AUTH;
    app = Fastify();
    app.register(fastifyWebsocket);
    app.register(async function (fastify) {
      fastify.get('/stream', { websocket: true }, (connection, req) => {
        handleConnection(connection, req);
      });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    url = `ws://127.0.0.1:${address.port}/stream`;
  });

  afterAll(async () => { await app.close(); });

  function connect(claims: Record<string, unknown>, onWelcome: (ws: WebSocket) => void) {
    mockVerify.mockResolvedValueOnce({ exp: Math.floor(Date.now() / 1000) + 300, ...claims });
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', v: 1, token: 't' })));
    ws.on('message', (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.type === 'welcome') onWelcome(ws);
    });
    return ws;
  }

  it('closes a connection that floods the subscribe path', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no close within 3000ms')), 3000);
      const ws = connect({ sub: 'flooder' }, (sock) => {
        for (let i = 0; i < 400; i += 1) {
          sock.send(JSON.stringify({ action: 'subscribe', pluginId: 'plugin-1' }));
        }
      });
      ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    expect(closed).toBe(WS_CLOSE_RATE_LIMIT);
  });

  it('closes a connection that subscribes outside its scope', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no close within 3000ms')), 3000);
      const ws = connect({ sub: 'scoped', scope: 'plugins:read:earthquakes' }, (sock) => {
        sock.send(JSON.stringify({ action: 'subscribe', pluginId: 'wildfire' }));
      });
      ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    expect(closed).toBe(WS_CLOSE_NOT_IN_SCOPE);
  });

  it('serves a subscription that is inside the ticket scope', async () => {
    const got = await new Promise<boolean>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no data within 3000ms')), 3000);
      const ws = connect({ sub: 'scoped', scope: 'plugins:read:earthquakes' }, (sock) => {
        sock.send(JSON.stringify({ action: 'subscribe', pluginId: 'earthquakes' }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'data' && data.pluginId === 'earthquakes') { clearTimeout(t); ws.close(); resolve(true); }
      });
    });
    expect(got).toBe(true);
  });
});
