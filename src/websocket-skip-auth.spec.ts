// vi.hoisted is hoisted above all imports by Vitest's transform pipeline,
// ensuring the env var is set before websocket.ts evaluates `const SKIP_WS_AUTH = ...`.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WWV_SKIP_WS_AUTH = 'true';
});

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';

// Mock jwt-auth so we can control verifyEngineToken behavior without needing
// a real JWKS endpoint.
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

const mockVerify = verifyEngineToken as ReturnType<typeof vi.fn>;

// Helper: capture console output during a test
function captureConsole() {
  const logs: { level: string; args: string[] }[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: string[]) => logs.push({ level: 'log', args });
  console.warn = (...args: string[]) => logs.push({ level: 'warn', args });
  console.error = (...args: string[]) => logs.push({ level: 'error', args });

  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

describe('SKIP_WS_AUTH=true — accepts auth post-welcome', () => {
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

  afterEach(() => {
    mockVerify.mockReset();
  });

  it('sends welcome immediately without auth message in SKIP_WS_AUTH mode', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout: expected welcome within 2000ms')), 2000);

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

  it('accepts valid JWT auth message post-welcome — logs verified, stays open', async () => {
    mockVerify.mockResolvedValueOnce({
      sub: 'user-123',
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const consoleCapture = captureConsole();

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout')), 3000);
      let welcomeReceived = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          welcomeReceived = true;
          // Send auth JWT after welcome
          ws.send(JSON.stringify({ type: 'auth', v: 1, token: 'valid.jwt.token' }));
        }
      });

      // Wait a short time after sending auth to verify we stay open
      // (no close with 4003) and the console logged the verification.
      setTimeout(() => {
        clearTimeout(t);
        expect(welcomeReceived).toBe(true);

        // Verify the mock was called
        expect(mockVerify).toHaveBeenCalledTimes(1);

        // Verify console output
        const verifyLogs = consoleCapture.logs.filter(
          (l) => l.level === 'log' && l.args[0].includes('Auth verified post-welcome')
        );
        expect(verifyLogs.length).toBe(1);
        expect(verifyLogs[0].args[0]).toContain('userId: user-123');

        consoleCapture.restore();
        ws.close();
        resolve();
      }, 500);
    });
  });

  it('accepts invalid JWT auth message post-welcome — logs warning, stays open', async () => {
    mockVerify.mockRejectedValueOnce(new Error('Token signature invalid'));

    const consoleCapture = captureConsole();

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout')), 3000);
      let welcomeReceived = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          welcomeReceived = true;
          ws.send(JSON.stringify({ type: 'auth', v: 1, token: 'bad.jwt.token' }));
        }
      });

      ws.on('close', (code) => {
        clearTimeout(t);
        consoleCapture.restore();
        // The connection should NOT close — this test would fail if 4003 is sent
        reject(new Error(`Connection closed unexpectedly with code ${code} — should have stayed open`));
      });

      // Wait to verify we stay open and log the warning
      setTimeout(() => {
        clearTimeout(t);
        expect(welcomeReceived).toBe(true);
        expect(mockVerify).toHaveBeenCalledTimes(1);

        const warnLogs = consoleCapture.logs.filter(
          (l) => l.level === 'warn' && l.args[0].includes('Auth verification failed')
        );
        expect(warnLogs.length).toBe(1);
        expect(warnLogs[0].args[0]).toContain('Token signature invalid');

        consoleCapture.restore();
        ws.close();
        resolve();
      }, 500);
    });
  });

  it('can subscribe without authentication in SKIP_WS_AUTH mode', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout')), 2000);
      let welcomeReceived = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          welcomeReceived = true;
          ws.send(JSON.stringify({ action: 'subscribe', pluginId: 'plugin-1' }));
        }
        if (data.type === 'data') {
          // Got data back — subscribe worked without auth
          clearTimeout(t);
          expect(welcomeReceived).toBe(true);
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

describe('SKIP_WS_AUTH mode — re-auth forbidden after JWT upgrade', () => {
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
  });

  it('re-authentication is forbidden after JWT auth upgrades the connection in SKIP_WS_AUTH mode', async () => {
    // In SKIP_WS_AUTH mode, the first auth message upgrades the connection from
    // bypassed to fully-verified (authBypassed=false). A second auth message
    // sent after the first resolves should be rejected with 4003, same as in
    // normal mode.
    mockVerify.mockResolvedValue({
      sub: 'tenant-1',
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => reject(new Error('Timeout')), 3000);
      let welcomeReceived = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          welcomeReceived = true;
          // Send first auth after welcome — this should upgrade authBypassed
          ws.send(JSON.stringify({ type: 'auth', v: 1, token: 'first.jwt.token' }));
        }
      });

      ws.on('close', (code) => {
        clearTimeout(t);
        try {
          expect(welcomeReceived).toBe(true);
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      // Send second auth after the first one has time to verify and upgrade
      // authBypassed from true to false.
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token: 'second.jwt.token' }));
      }, 400);
    });
  });
});
