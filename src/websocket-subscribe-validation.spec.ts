// vi.hoisted is hoisted above all imports by Vitest's transform pipeline,
// ensuring WWV_SKIP_WS_AUTH is set before websocket.ts evaluates
// `const SKIP_WS_AUTH = ...`, so connections can be established without a JWT.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WWV_SKIP_WS_AUTH = 'true';
});

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';

vi.mock('./jwt-auth', () => ({
  verifyEngineToken: vi.fn(),
}));

vi.mock('./redis', () => ({
  getLiveSnapshot: vi.fn().mockResolvedValue({ mocked: true }),
}));

vi.mock('./scheduler', () => ({
  getRegisteredPluginIds: vi.fn().mockReturnValue(['plugin-1']),
}));

import { handleConnection, WS_CLOSE_INVALID_PLUGIN_ID, WS_CLOSE_SUBSCRIPTION_LIMIT } from './websocket';

describe('Subscription validation — pluginId format and per-connection cap', () => {
  let app: any;
  let url: string;
  const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;

  beforeAll(async () => {
    app = Fastify();
    app.register(fastifyWebsocket);

    app.register(async function (fastify: any) {
      fastify.get('/stream', { websocket: true }, (connection: any, req: any) => {
        handleConnection(connection, req);
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    url = `ws://127.0.0.1:${address.port}/stream`;
    process.env.ALLOWED_ORIGINS = '*';
  });

  afterAll(async () => {
    await app.close();
    delete process.env.WWV_SKIP_WS_AUTH;
    vi.restoreAllMocks();
  });

  // Connect under SKIP_WS_AUTH and resolve once the welcome message arrives
  // (i.e. the socket is ready to subscribe).
  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for welcome')), 3000);
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          clearTimeout(t);
          resolve();
        }
      });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005) {
          clearTimeout(t);
          reject(new Error(`Closed unexpectedly with code ${code}`));
        }
      });
    });
    return ws;
  }

  it.each([
    ['missing pluginId', JSON.stringify({ action: 'subscribe' })],
    ['empty string', JSON.stringify({ action: 'subscribe', pluginId: '' })],
    ['uppercase', JSON.stringify({ action: 'subscribe', pluginId: 'PLUGIN-1' })],
    ['camelCase', JSON.stringify({ action: 'subscribe', pluginId: 'conflictEvents' })],
    ['trailing hyphen', JSON.stringify({ action: 'subscribe', pluginId: 'plugin-' })],
    ['leading hyphen', JSON.stringify({ action: 'subscribe', pluginId: '-plugin' })],
    ['double hyphen', JSON.stringify({ action: 'subscribe', pluginId: 'plugin--1' })],
    ['underscore', JSON.stringify({ action: 'subscribe', pluginId: 'plugin_1' })],
    ['slash traversal', JSON.stringify({ action: 'subscribe', pluginId: '../../etc/passwd' })],
    ['non-string number', JSON.stringify({ action: 'subscribe', pluginId: 42 })],
    ['too long (65 chars)', JSON.stringify({ action: 'subscribe', pluginId: 'a'.repeat(65) })],
  ])('rejects invalid pluginId — %s — with close 4400', async (_label, payload) => {
    const ws = await connect();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: expected close 4400 within 3000ms')), 3000);
      ws.send(payload);
      ws.on('close', (code) => {
        clearTimeout(t);
        try {
          expect(code).toBe(WS_CLOSE_INVALID_PLUGIN_ID);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('accepts a valid kebab-case pluginId and pushes the cached snapshot', async () => {
    const ws = await connect();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: expected data within 3000ms')), 3000);
      ws.send(JSON.stringify({ action: 'subscribe', pluginId: 'plugin-1' }));
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'data') {
          clearTimeout(t);
          try {
            expect(data.pluginId).toBe('plugin-1');
            expect(data.payload).toEqual({ mocked: true });
            resolve();
          } catch (e) {
            reject(e);
            return;
          }
          ws.close();
        }
      });
    });
  });

  it('closes with 4401 when the per-connection subscription cap is exceeded', async () => {
    const ws = await connect();
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: expected close 4401 within 5000ms')), 5000);
      // MAX (50) valid subscriptions are admitted; the 51st must close.
      for (let i = 1; i <= MAX_SUBSCRIPTIONS_PER_CONNECTION + 1; i++) {
        ws.send(JSON.stringify({ action: 'subscribe', pluginId: `plugin-${i}` }));
      }
      ws.on('close', (code) => {
        clearTimeout(t);
        try {
          expect(code).toBe(WS_CLOSE_SUBSCRIPTION_LIMIT);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
