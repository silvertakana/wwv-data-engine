import type { FastifyInstance, FastifyReply, FastifyPluginAsync } from 'fastify';
import { redis, getLiveSnapshot } from './redis';
import { seederStatus, seederMeta, allSeederHealth } from './scheduler';
import { canonicalSeederFor } from './seeder-aliases';
import { toKebabCase } from './seeder-loader';

// Distinguishable marker for a Redis OPERATIONAL failure, as opposed to a clean
// miss on the key. server.ts's snapshot routes map this to a 503; a null return
// stays a 404. Introduced so a Redis outage is not misread as "snapshot absent".
export const REDIS_UNAVAILABLE = 'redis-unavailable';

// Health liveness bookkeeping: how many consecutive ping timeouts we have seen.
// Reset to 0 by any successful ping. /health only reports 'degraded' once the
// count reaches 3, and it NEVER flips the HTTP status — so a single blip can't
// trip a restart-loop that expects a non-2xx to mean "down".
let consecutivePingFailures = 0;
const PING_TIMEOUT_MS = 1500;

// Test-only: reset the failure counter so acceptance tests can drive the
// degenerate path from a clean slate. Not part of the public health contract.
export function resetRedisHealthCounters(): void {
  consecutivePingFailures = 0;
}

async function pingRedis(): Promise<'ok' | 'unreachable'> {
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS)
      ),
    ]);
    consecutivePingFailures = 0;
    return 'ok';
  } catch {
    consecutivePingFailures += 1;
    return 'unreachable';
  }
}

async function handleSnapshotRequest(id: string, reply: FastifyReply) {
  // Resolve UI-plugin aliases to the canonical seeder name. Plugins ask
  // under their own id (e.g. "conflict-zones") but seeders may be running
  // under a different declared name (e.g. "conflict-events"). Without
  // this, every snapshot request from an alias-using plugin 404s even
  // when the seeder is alive.
  const seederName = canonicalSeederFor(id);

  // Try the alias-resolved name first, then kebab-case normalization of
  // the raw id, then the raw id itself. First hit wins; each lookup is a
  // cheap Redis GET on a rate-limited route.
  const candidates = [seederName, toKebabCase(id)];
  if (!candidates.includes(id)) candidates.push(id);

  let snapshot: unknown = null;
  try {
    for (const candidate of candidates) {
      snapshot = await getLiveSnapshot(candidate);
      if (snapshot) break;
    }
  } catch (err) {
    // getLiveSnapshot throws REDIS_UNAVAILABLE on an operational Redis
    // failure (never on a clean miss). Surface that as 503 rather than 404.
    if (err instanceof Error && err.message === REDIS_UNAVAILABLE) {
      return reply.status(503).send({ error: REDIS_UNAVAILABLE });
    }
    throw err;
  }

  if (!snapshot) {
    return reply.status(404).send({ error: 'Snapshot not found or seeder not running' });
  }

  // Some seeders wrap their output in { items: ... }, others don't. If there
  // is no `items` property, wrap so the frontend always gets the object shape
  // it expects downstream.
  if (typeof snapshot === 'object' && snapshot !== null && !('items' in snapshot)) {
    return { items: snapshot };
  }

  return snapshot;
}

/**
 * Pure Fastify plugin for the /health and snapshot routes. Registered by
 * server.ts in production and (with mocks for ./redis and ./scheduler)
 * directly by tests, so the acceptance criteria are exercised without booting
 * the real server.
 */
export const routesPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/health', async () => {
    const redisState = await pingRedis();
    return {
      status: redisState === 'unreachable' && consecutivePingFailures >= 3 ? 'degraded' : 'ok',
      engine: 'wwv-data-engine',
      timestamp: Date.now(),
      seeders: seederStatus,
      seederMeta,
      // Per-seeder wire-contract health (see seeder-health.ts), computed at
      // request time so `stale` reflects cadence-aware freshness right now.
      seederHealth: allSeederHealth(),
      redis: redisState,
    };
  });

  app.get('/api/:id', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return handleSnapshotRequest(id, reply);
  });

  // Backwards-compatible alias — plugin bundles published before the /api/:id
  // refactor call this path. Keep in sync with /api/:id above.
  app.get('/data/:id', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return handleSnapshotRequest(id, reply);
  });
};
