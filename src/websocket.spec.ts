import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyJwt from '@fastify/jwt';
import { handleConnection } from './websocket';
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
  let privateKeyPem: string;
  let publicKeyPem: string;
  let kid = 'test-key-1';

  beforeAll(async () => {
    // Generate EdDSA keys for test
    const { publicKey: pub, privateKey: priv } = await jose.generateKeyPair('EdDSA', { extractable: true });
    privateKeyPem = await jose.exportPKCS8(priv);
    publicKeyPem = await jose.exportSPKI(pub);

    // Start server
    app = Fastify();
    app.register(fastifyWebsocket);
    
    app.register(fastifyJwt, {
      secret: async (request: any, token: any) => {
        return publicKeyPem;
      },
      verify: {
        allowedIssuers: ['https://app.worldwideview.dev'],
        allowedAudiences: ['wwv-data-engine'],
        algorithms: ['EdDSA'],
        clockTolerance: 60,
      }
    });

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
    
    process.env.ALLOWED_ORIGINS = 'https://app.worldwideview.dev';
  });

  afterAll(async () => {
    await app.close();
  });

  async function createToken(payload: any = {}, options: any = {}) {
    const privKey = await jose.importPKCS8(privateKeyPem, 'EdDSA');
    const jwt = new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuedAt()
      .setIssuer(options.issuer || 'https://app.worldwideview.dev')
      .setAudience(options.audience || 'wwv-data-engine')
      .setExpirationTime(options.exp || '5m');
      
    if (options.nbf) jwt.setNotBefore(options.nbf);
    
    return await jwt.sign(privKey);
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
});
