import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';

// Mock jwt-auth before importing websocket so handleConnection picks up the mock.
// This sidesteps the module-singleton keyResolver cache in jwt-auth.ts that
// cannot be reset between test files sharing the same Vitest worker.
vi.mock('./jwt-auth', () => ({
  verifyEngineToken: vi.fn(),
}));

vi.mock('./redis', () => ({
  getLiveSnapshot: vi.fn().mockResolvedValue({ mocked: true }),
}));

vi.mock('./scheduler', () => ({
  getRegisteredPluginIds: vi.fn().mockReturnValue(['plugin-1']),
}));

import { handleConnection } from './websocket';
import { verifyEngineToken } from './jwt-auth';

describe('Auth enforcement — valid JWT sends welcome (mocked verifyEngineToken)', () => {
  let app: any;
  let url: string;
  const mockVerify = verifyEngineToken as ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    // WWV_SKIP_WS_AUTH must NOT be 'true' — auth enforcement must be active.
    // websocket.ts reads SKIP_WS_AUTH at module import time, and since this file
    // is in its own Vitest module scope, the env var is read fresh here.
    delete process.env.WWV_SKIP_WS_AUTH;

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
  });

  it('sends welcome message when client sends a valid auth message as the first message', async () => {
    // verifyEngineToken resolves with valid claims — engine must accept and send welcome.
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    mockVerify.mockResolvedValueOnce({ sub: 'test-tenant', exp: futureExp });

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout: expected welcome within 2000ms')), 2000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token: 'any.signed.token' }));
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          clearTimeout(t);
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
