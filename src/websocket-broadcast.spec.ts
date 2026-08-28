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
  getLiveSnapshot: vi.fn().mockResolvedValue(null),
}));

vi.mock('./scheduler', () => ({
  getRegisteredPluginIds: vi.fn().mockReturnValue(['conflict-events']),
}));

import { handleConnection, broadcastPluginData, broadcastSeederStatus } from './websocket';

// Capture the server-side connection objects as they are wired up so tests can
// inspect/replace individual socket behavior (e.g. a throwing `send`).
const serverSockets: WebSocket[] = [];

describe('WebSocket broadcast fan-out', () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(fastifyWebsocket);

    app.register(async function (fastify) {
      fastify.get('/stream', { websocket: true }, (connection, req) => {
        serverSockets.push(connection);
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
    serverSockets.length = 0;
  });

  // Opens a client socket, and when it has received its welcome frame,
  // subscribes it to the given id. Resolves once the server has registered the
  // subscription (guaranteed before the subscribe action is echoed back).
  function subscribe(id: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`Timeout: never subscribed to ${id}`));
      }, 3000);
      ws.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          ws.send(JSON.stringify({ action: 'subscribe', pluginId: id }));
          clearTimeout(t);
          resolve(ws);
        }
      });
    });
  }

  // Collects received frames until `predicate` matches; resolves with the full
  // collected list (each frame carrying its raw string).
  function collectFrames(
    ws: WebSocket,
    predicate: (f: { type: string }) => boolean,
  ): Promise<{ type: string; pluginId?: string; raw?: string; payload?: unknown; status?: unknown; lastGood?: unknown }[]> {
    return new Promise((resolve, reject) => {
      const frames: { type: string; pluginId?: string; raw?: string; payload?: unknown; status?: unknown; lastGood?: unknown }[] = [];
      const t = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for matching frame'));
      }, 3000);
      ws.on('message', (msg) => {
        const raw = msg.toString();
        const data = JSON.parse(raw);
        frames.push({ ...data, raw });
        if (predicate(data)) {
          clearTimeout(t);
          resolve(frames);
        }
      });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005) {
          clearTimeout(t);
          reject(new Error(`Socket closed unexpectedly: ${code}`));
        }
      });
    });
  }

  // Yields long enough for the server's message handler to register each
  // subscription before a broadcast is issued.
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it('AC-C1: two subscriptions to the same id receive identical raw strings on one broadcast', async () => {
    const a = await subscribe('conflict-events');
    const b = await subscribe('conflict-events');
    await settle();

    const framesA = collectFrames(a, (f) => f.type === 'data');
    const framesB = collectFrames(b, (f) => f.type === 'data');

    broadcastPluginData('conflict-events', { source: 'conflict-events', items: [1] });

    const [fa, fb] = await Promise.all([framesA, framesB]);
    const rawA = fa.find((f) => f.type === 'data')!.raw;
    const rawB = fb.find((f) => f.type === 'data')!.raw;
    expect(rawA).toBeDefined();
    expect(rawB).toBeDefined();
    expect(rawA).toBe(rawB); // one serialized string shared verbatim

    a.close();
    b.close();
  });

  it('AC-C2: canonical subscriber vs alias subscriber each receive their own pluginId', async () => {
    const canonical = await subscribe('conflict-events');
    const alias = await subscribe('conflict-zones'); // alias of conflict-events
    await settle();

    const framesCanon = collectFrames(canonical, (f) => f.type === 'data');
    const framesAlias = collectFrames(alias, (f) => f.type === 'data');

    broadcastPluginData('conflict-events', { source: 'conflict-events', items: [2] });

    const [fc, fa] = await Promise.all([framesCanon, framesAlias]);
    const dataC = fc.find((f) => f.type === 'data')!;
    const dataA = fa.find((f) => f.type === 'data')!;

    // Each subscriber sees the id it asked for, not the other's.
    expect(dataC.pluginId).toBe('conflict-events');
    expect(dataA.pluginId).toBe('conflict-zones');
    // The two frames genuinely differ per subscriber.
    expect(dataC.raw).not.toBe(dataA.raw);
    expect(dataC.payload).toEqual({ source: 'conflict-events', items: [2] });

    canonical.close();
    alias.close();
  });

  it('AC-C3: a throwing send is isolated — broadcast does not throw, the healthy connection still receives, and the throwing socket is terminated', async () => {
    const healthy = await subscribe('satellite');
    // Force the healthy subscription to register before the evil one is set up.
    const evil = await subscribe('satellite');
    await settle();

    // The two OPEN server-side sockets: the most recently added is evil.
    const open = serverSockets.filter((s) => s.readyState === WebSocket.OPEN);
    const evilServerSocket = open[open.length - 1];
    const healthyServerSocket = open[open.length - 2];
    expect(evilServerSocket).toBeDefined();
    expect(healthyServerSocket).toBeDefined();
    expect(evilServerSocket).not.toBe(healthyServerSocket);

    // Capture the original implementation before the spy replaces it. Widen to
    // a loose callable so the overloaded `send` can be red-patched cleanly.
    const realSend = WebSocket.prototype.send as unknown as (
      this: WebSocket,
      ...args: unknown[]
    ) => void;

    const sendSpy = vi
      .spyOn(WebSocket.prototype, 'send')
      .mockImplementation(function (this: WebSocket, ...args: unknown[]) {
        if (this === evilServerSocket) throw new Error('bad send');
        return realSend.apply(this, args);
      });

    const healthyFrames = collectFrames(healthy, (f) => f.type === 'data');
    // Client-side, the evil socket is terminated server-side → it closes.
    const evilClosed = new Promise<number>((resolve) => {
      evil.on('close', (code) => resolve(code));
    });

    try {
      let thrown: unknown = null;
      try {
        broadcastPluginData('satellite', { source: 'satellite', items: [3] });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeNull(); // the broadcast must not rethrow

      const hFrame = await healthyFrames;
      expect(hFrame.some((f) => f.type === 'data')).toBe(true);
      expect(hFrame.find((f) => f.type === 'data')!.payload).toEqual({ source: 'satellite', items: [3] });

      const closeCode = await evilClosed;
      expect(closeCode).not.toBe(1000); // terminated, not a clean close

      // The healthy server-side socket must still be alive after the broadcast.
      expect(healthyServerSocket.readyState).toBe(WebSocket.OPEN);
    } finally {
      sendSpy.mockRestore();
      healthy.close();
    }
  });

  it('AC-C4: broadcastSeederStatus emits a type:"status" frame with pluginId = subscribed id', async () => {
    const ws = await subscribe('conflict-zones'); // alias subscription
    await settle();
    ws.removeAllListeners('message');

    const frames = collectFrames(ws, (f) => f.type === 'status');
    broadcastSeederStatus('conflict-events', { status: 'healthy', lastGood: '2024-01-01T00:00:00Z' });

    const got = await frames;
    const statusFrame = got.find((f) => f.type === 'status')!;
    expect(statusFrame.pluginId).toBe('conflict-zones');
    expect(statusFrame.status).toBe('healthy');
    expect(statusFrame.lastGood).toBe('2024-01-01T00:00:00Z');

    ws.close();
  });
});
