// vi.hoisted is hoisted above all imports by Vitest's transform pipeline,
// ensuring WWV_SKIP_WS_AUTH is set before websocket.ts evaluates
// `const SKIP_WS_AUTH = ...`, so connections can be established without a JWT.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WWV_SKIP_WS_AUTH = 'true';
});

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';

vi.mock('./jwt-auth', () => ({
  verifyEngineToken: vi.fn(),
}));

vi.mock('./redis', () => ({
  // Only the canonical "conflict-events" snapshot exists. Alias ids and
  // unrelated ids miss on purpose so the canonical-name resolution on the
  // subscribe path is observable.
  getLiveSnapshot: vi.fn().mockImplementation((source: string) => {
    if (source === 'conflict-events') {
      return Promise.resolve({ source: 'conflict-events', items: [1] });
    }
    return Promise.resolve(null);
  }),
}));

vi.mock('./scheduler', () => ({
  getRegisteredPluginIds: vi.fn().mockReturnValue(['conflict-events']),
}));

import { handleConnection, broadcastPluginData } from './websocket';
import { getLiveSnapshot } from './redis';

const mockGetLiveSnapshot = getLiveSnapshot as ReturnType<typeof vi.fn>;

describe('WebSocket seeder-alias delivery', () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(fastifyWebsocket);

    app.register(async function (fastify) {
      fastify.get('/stream', { websocket: true }, (connection, req) => {
        handleConnection(connection, req);
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to resolve test server address');
    }
    url = `ws://127.0.0.1:${address.port}/stream`;
    process.env.ALLOWED_ORIGINS = '*';
  });

  afterAll(async () => {
    await app.close();
    delete process.env.WWV_SKIP_WS_AUTH;
    vi.restoreAllMocks();
  });

  it('subscribe under a UI-plugin alias pushes the snapshot fetched under the canonical seeder name', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout: expected data within 2000ms')), 2000);
      let welcomeReceived = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          welcomeReceived = true;
          mockGetLiveSnapshot.mockClear();
          ws.send(JSON.stringify({ action: 'subscribe', pluginId: 'conflict-zones' }));
        }
        if (data.type === 'data') {
          clearTimeout(t);
          try {
            expect(welcomeReceived).toBe(true);
            expect(data.pluginId).toBe('conflict-zones');
            expect(mockGetLiveSnapshot).toHaveBeenCalledWith('conflict-events');
          } catch (e) {
            ws.close();
            reject(e);
            return;
          }
          ws.close();
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
  });

  it('broadcast under the canonical seeder name delivers to an alias subscriber under the subscriber id', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout: expected broadcast within 2000ms')), 2000);

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          // Subscribe under an alias whose canonical seeder has no snapshot
          // in the mock, so the subscribe push is skipped and the broadcast
          // below is the only data message.
          ws.send(JSON.stringify({ action: 'subscribe', pluginId: 'cyber-attacks' }));
          setTimeout(() => {
            broadcastPluginData('cyberAttacks', { source: 'cyberAttacks', items: [42] });
          }, 100);
        }
        if (data.type === 'data') {
          clearTimeout(t);
          try {
            expect(data.pluginId).toBe('cyber-attacks');
            expect(data.payload.items).toEqual([42]);
          } catch (e) {
            ws.close();
            reject(e);
            return;
          }
          ws.close();
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
  });

  it('broadcast under a non-aliased seeder name still delivers with the same id', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout: expected broadcast within 2000ms')), 2000);

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          ws.send(JSON.stringify({ action: 'subscribe', pluginId: 'satellite' }));
          setTimeout(() => {
            broadcastPluginData('satellite', { source: 'satellite', items: [7] });
          }, 100);
        }
        if (data.type === 'data') {
          clearTimeout(t);
          try {
            expect(data.pluginId).toBe('satellite');
            expect(data.payload.items).toEqual([7]);
          } catch (e) {
            ws.close();
            reject(e);
            return;
          }
          ws.close();
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
  });
});
