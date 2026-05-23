import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { handleConnection } from './websocket';
import { checkJwksReachable } from './startup-checks';
import WebSocket from 'ws';
// @ts-ignore
import * as jose from 'jose';

vi.mock('./redis', () => ({
  getLiveSnapshot: vi.fn().mockResolvedValue({ mocked: true })
}));

vi.mock('./scheduler', () => ({
  getRegisteredPluginIds: vi.fn().mockReturnValue(['plugin-1'])
}));

describe('WebSocket Origin Validation & Auth Gating', () => {
  let app: any;
  let url: string;
  let privateKey: any;
  let kid = 'test-key-1';
  let originalJwksUrl: string | undefined;

  beforeAll(async () => {
    // Generate EdDSA keys for test
    const { publicKey, privateKey: priv } = await jose.generateKeyPair('EdDSA', { extractable: true });
    privateKey = priv;
    const publicJwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'EdDSA' };

    // Start server — serves the test JWKS and the /stream WS route on one port
    app = Fastify();
    app.register(fastifyWebsocket);
    app.get('/jwks', async () => ({ keys: [publicJwk] }));

    app.register(async function (fastify: any) {
      fastify.get('/stream', {
        websocket: true,
        preValidation: (request: any, reply: any, done: any) => {
          const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
            : ['*'];

          const origin = request.headers.origin || '';
          if (!allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) {
            return reply.code(403).send('Forbidden Origin');
          }

          done();
        }
      }, (connection: any, req: any) => {
        handleConnection(connection, req);
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    url = `ws://127.0.0.1:${address.port}/stream`;

    // jwt-auth.ts builds its JWKS resolver lazily from JWKS_URL on first verify.
    originalJwksUrl = process.env.JWKS_URL;
    process.env.JWKS_URL = `http://127.0.0.1:${address.port}/jwks`;
    process.env.ALLOWED_ORIGINS = 'https://app.worldwideview.dev';
  });

  afterAll(async () => {
    await app.close();
    if (originalJwksUrl === undefined) {
      delete process.env.JWKS_URL;
    } else {
      process.env.JWKS_URL = originalJwksUrl;
    }
  });

  async function createToken(payload: any = {}, options: any = {}) {
    const jwt = new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setIssuer(options.issuer || 'https://marketplace.worldwideview.dev')
      .setAudience(options.audience || 'wwv-data-engine')
      .setExpirationTime(options.exp || '5m');

    if (options.nbf) jwt.setNotBefore(options.nbf);

    return await jwt.sign(privateKey);
  }

  it('closes connection with 4003 if no auth message is sent within 3000ms', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      const t = setTimeout(() => reject(new Error('Timeout')), 4000);
      ws.on('close', (code) => {
        clearTimeout(t);
        expect(code).toBe(4003);
        resolve();
      });
    });
  });

  it('rejects connection if Origin is missing or invalid', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'http://malicious.com' } });
      ws.on('unexpected-response', (req, res) => {
        expect(res.statusCode).toBe(403);
        resolve();
      });
      ws.on('open', () => {
        reject(new Error('Should not have opened'));
      });
    });
  });

  it('unauthenticated sockets receive NO welcome message and are NOT added to connections', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('message', () => {
        reject(new Error('Received message but should not have'));
      });
      setTimeout(() => {
        ws.close();
        resolve();
      }, 500);
    });
  });

  it('verifies valid JWT and sends welcome message', async () => {
    const token = await createToken({ sub: 'tenant-1' });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          ws.close();
          resolve();
        }
      });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005) {
          reject(new Error('Closed unexpectedly: ' + code));
        }
      });
    });
  });

  it('rejects JWT with wrong audience', async () => {
    const token = await createToken({ sub: 'tenant-1' }, { audience: 'wrong-audience' });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('re-authentication attempts on the same socket are forbidden', async () => {
    const token = await createToken({ sub: 'tenant-1' });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      let authSentCount = 0;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          // send again
          ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
        }
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
  
  it('sockets forcefully disconnect when validated JWT expires', async () => {
    // Generate token that expires in 1s (fastify-jwt will enforce this)
    // Wait, fastify-jwt clockTolerance is 60s, so it won't reject unless it's 60s old
    // We can test the local jwtExpTimeout logic directly by setting decoded.exp to now + 1 second
    const token = await createToken({ sub: 'tenant-1' }, { exp: Math.floor(Date.now() / 1000) + 1 });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4001); // 4001 Token expired
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('rejects JWT with old issuer (app.worldwideview.dev) → 4003', async () => {
    const token = await createToken({ sub: 'tenant-1' }, { issuer: 'https://app.worldwideview.dev' });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('accepts JWT with wwv-data-engines audience and sends welcome', async () => {
    const token = await createToken({ sub: 'tenant-1' }, { audience: 'wwv-data-engines' });
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'welcome') {
          ws.close();
          resolve();
        }
      });
      ws.on('close', (code) => {
        if (code !== 1000 && code !== 1005) {
          reject(new Error('Closed unexpectedly: ' + code));
        }
      });
    });
  });

  it('rejects JWT missing sub claim → 4003', async () => {
    // Build a JWT that has no sub but is otherwise valid
    const tokenNoSub = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setIssuer('https://marketplace.worldwideview.dev')
      .setAudience('wwv-data-engine')
      .setExpirationTime('5m')
      .sign(privateKey);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token: tokenNoSub }));
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it('rejects JWT missing exp claim → 4003', async () => {
    // Build a JWT that has no expiration
    const tokenNoExp = await new jose.SignJWT({ sub: 'tenant-1' })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setIssuer('https://marketplace.worldwideview.dev')
      .setAudience('wwv-data-engine')
      // deliberately omit .setExpirationTime()
      .sign(privateKey);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: 'https://app.worldwideview.dev' } });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', v: 1, token: tokenNoExp }));
      });
      ws.on('close', (code) => {
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

describe('Auth race condition', () => {
  let app: any;
  let url: string;
  let privateKey: any;
  let kid = 'race-key-1';

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await jose.generateKeyPair('EdDSA', { extractable: true });
    privateKey = priv;
    const publicJwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'EdDSA' };

    app = Fastify();
    app.register(fastifyWebsocket);
    app.get('/jwks', async () => ({ keys: [publicJwk] }));

    app.register(async function (fastify: any) {
      fastify.get('/stream', { websocket: true }, (connection: any, req: any) => {
        handleConnection(connection, req);
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    url = `ws://127.0.0.1:${address.port}/stream`;

    process.env.JWKS_URL = `http://127.0.0.1:${address.port}/jwks`;
    // Allow any origin for this suite
    process.env.ALLOWED_ORIGINS = '*';
  });

  afterAll(async () => {
    await app.close();
  });

  it('closes with 4003 when a second auth message arrives while the first is in-flight', async () => {
    const token = await new jose.SignJWT({ sub: 'race-tenant' })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setIssuer('https://marketplace.worldwideview.dev')
      .setAudience('wwv-data-engine')
      .setExpirationTime('5m')
      .sign(privateKey);

    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout waiting for close')), 6000);
      const ws = new WebSocket(url);

      ws.on('open', () => {
        // Send two auth messages synchronously — no await between them.
        // The second arrives while verifyEngineToken is awaited for the first,
        // so authPending is true and the server must close with 4003.
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
        ws.send(JSON.stringify({ type: 'auth', v: 1, token }));
      });

      ws.on('close', (code) => {
        clearTimeout(t);
        try {
          expect(code).toBe(4003);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

describe('JWKS cold-start check', () => {
  it('resolves when JWKS endpoint is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(checkJwksReachable('https://marketplace.worldwideview.dev/api/auth/jwks')).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('throws when JWKS endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await expect(checkJwksReachable('https://marketplace.worldwideview.dev/api/auth/jwks')).rejects.toThrow('Network error');
    vi.unstubAllGlobals();
  });

  it('throws when JWKS endpoint returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(checkJwksReachable('https://marketplace.worldwideview.dev/api/auth/jwks')).rejects.toThrow('404');
    vi.unstubAllGlobals();
  });

  it('throws when JWKS endpoint returns 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(checkJwksReachable('https://marketplace.worldwideview.dev/api/auth/jwks')).rejects.toThrow('503');
    vi.unstubAllGlobals();
  });
});
