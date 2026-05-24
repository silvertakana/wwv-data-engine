import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

import Fastify from 'fastify';
import { startScheduler } from './scheduler';
import { seederStatus } from './scheduler';
import { discoverSeeders } from './seeder-loader';
import { registerSeeders } from './scheduler';

// Boot Fastify
export const fastify = Fastify({
  logger: false // Keep it clean for the console
});

fastify.setErrorHandler(function (error: any, request, reply) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, {
      extra: {
        method: request.method,
        url: request.url,
      }
    });
  }
  console.error('[Fastify Global Error]', error);
  reply.status(error.statusCode || 500).send({ error: error.message });
});

import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCors from '@fastify/cors';
import { handleConnection } from './websocket';

fastify.register(fastifyRateLimit, {
  max: 2000,
  timeWindow: '1 minute'
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

fastify.register(fastifyCors, {
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  methods: ['GET', 'OPTIONS'],
});

// JWT ticket verification (ADR-001B) lives in jwt-auth.ts and is exercised by
// the WebSocket first-message auth in websocket.ts — no Fastify plugin needed.

fastify.register(fastifyWebsocket);

fastify.register(async function (fastify) {
  // @ts-ignore - RouteShorthandOptions augmentation missing for websocket in strict mode
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

      if (process.env.NODE_ENV === 'production' && request.headers['x-forwarded-proto'] !== 'https') {
        return reply.code(403).send('HTTPS Required');
      }

      done();
    }
  }, (connection: any, req: any) => {
    handleConnection(connection, req);
  });
});

const PORT = parseInt(process.env.PORT || '5000', 10);

fastify.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    engine: 'wwv-data-engine',
    timestamp: Date.now(),
    seeders: seederStatus
  };
});

import { getRegisteredPluginIds } from './scheduler';
import { readFileSync } from 'fs';

const enginePkg = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

fastify.get('/manifest', async () => {
  return {
    engine: 'wwv-data-engine',
    version: enginePkg.version,
    plugins: getRegisteredPluginIds(),
    websocket: '/stream',
    timestamp: Date.now(),
  };
});

import { getLiveSnapshot } from './redis';

fastify.get('/api/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const snapshot = await getLiveSnapshot(id);
  
  if (!snapshot) {
    return reply.status(404).send({ error: 'Snapshot not found or seeder not running' });
  }

  // Some seeders wrap their output in { items: ... }, others don't.
  // To ensure the frontend always gets an object with `items` if it expects one,
  // we can check if `snapshot` already has `items`.
  if (snapshot && typeof snapshot === 'object' && !('items' in snapshot)) {
    return { items: snapshot };
  }

  return snapshot;
});

import { run as downloadSeeders } from './scripts/download-seeders';
import { checkJwksReachable } from './startup-checks';

async function start() {
  try {
    if (process.env.DOWNLOAD_SEEDERS === 'true') {
      console.log('[Server] DOWNLOAD_SEEDERS is true. Downloading latest seeders...');
      await downloadSeeders();
    }

    if (process.env.WWV_SKIP_WS_AUTH === 'true' && process.env.NODE_ENV === 'production') {
      console.error('[Server] FATAL: WWV_SKIP_WS_AUTH=true is forbidden in production. Unset this env var before deploying.');
      process.exit(1);
    }

    if (process.env.WWV_SKIP_WS_AUTH !== 'true') {
      const jwksUrl = process.env.JWKS_URL;
      if (!jwksUrl) {
        console.error('[Server] JWKS_URL required when auth is enabled');
        process.exit(1);
      }
      try {
        await checkJwksReachable(jwksUrl);
        console.log('[Server] JWKS reachable at', jwksUrl);
      } catch (e) {
        console.error('[Server] FATAL: JWKS unreachable at startup:', jwksUrl);
        process.exit(1);
      }
    }

    // 1. Discover dynamic seeders from configured directory
    const seeders = await discoverSeeders();
    registerSeeders(seeders);

    // 3. Start the Fastify API Server
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[Server] WWV Data Engine listening on port ${PORT}`);

    // 4. Start the Cron Scheduler
    startScheduler();

  } catch (err) {
    console.error('[Server] Fatal error during startup:', err);
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[Server] ${signal} received. Shutting down...`);
  await fastify.close();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start();
