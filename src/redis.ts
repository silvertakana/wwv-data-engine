import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';
import zlib from 'zlib';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ioredis gracefully handles standard redis:// as well as rediss:// (TLS, used by Upstash)
let redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

if (redisUrl.includes('upstash.io') && redisUrl.startsWith('redis://')) {
  console.warn('\n\x1b[33m[CONFIG WARNING]\x1b[0m 🚨 Upstash environment detected via redis:// without TLS.');
  console.warn('Automatically upgrading process connection pipeline to rediss:// protocol...\n');
  redisUrl = redisUrl.replace(/^redis:\/\//, 'rediss://');
}

console.log(`[Redis] Connecting to ${redisUrl.replace(/:[^:@]+@/, ':***@')} ...`);

export const redis = new Redis(redisUrl, {
  // Common reconnect strategy
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('[Redis] Connection Error against URL:', redisUrl.replace(/:[^:@]+@/, ':***@'));
  console.error('[Redis] Error Object:', err);
});

redis.on('ready', () => {
  console.log('[Redis] Connected and ready.');
});

import { broadcastPluginData } from './websocket';

const lastSnapshotTimes = new Map<string, number>();
const SNAPSHOT_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Stable, bounded, public-safe marker used when a live snapshot cannot be
 * published. Callers record the message as their lastError; the raw transport
 * error stays attached internally as the error's `cause` and is never exposed
 * through scheduler state or the health payload.
 */
export const SNAPSHOT_WRITE_FAILED = 'snapshot-write-failed';

/**
 * Convenience method to write a JSON payload to Redis with an expiration.
 * Writes are throttled to save Redis requests, but websockets are always broadcasted.
 *
 * Resolves for an intentional throttle skip and for a completed write. Rejects
 * with SNAPSHOT_WRITE_FAILED when the broadcast, serialization, compression, or
 * either Redis write actually fails, so callers never record a failed
 * publication as a success.
 */
export async function setLiveSnapshot(source: string, payload: unknown, ttlSeconds: number): Promise<void> {
  const now = Date.now();
  const previousReservation = lastSnapshotTimes.get(source);
  const admitted = now - (previousReservation ?? 0) >= SNAPSHOT_THROTTLE_MS;

  // Reserve the throttle window synchronously, before any await, so a duplicate
  // call arriving while this write is pending is still suppressed. A failed
  // attempt releases only its own reservation in the catch below.
  if (admitted) {
    lastSnapshotTimes.set(source, now);
  }

  try {
    // 1. ALWAYS broadcast newly updated entities to any active WebSocket subscribers
    // The data pipeline relies on this for high-frequency HUD updates.
    broadcastPluginData(source, payload);

    // 2. Throttle Redis snapshots to prevent blowing past 500K max request limits (e.g. Upstash)
    if (!admitted) {
      return; // Intentional throttle skip: a normal broadcast with no Redis write.
    }

    const key = `data:${source}:live`;
    const jsonStr = JSON.stringify(payload);

    // Compress JSON strings to drastically reduce Upstash payload size
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
    await redis.set(key, compressed, 'EX', ttlSeconds);

    // Also save a metadata key so healthcheck can verify
    await redis.set(`meta:${source}:last_run`, Date.now().toString(), 'EX', ttlSeconds * 2);

    console.log(`[Redis] Snapshot saved to Redis for ${source} (${(compressed.length / 1024).toFixed(2)} KB)`);
  } catch (error) {
    // Release ONLY this attempt's own reservation, so the next call retries
    // instead of waiting out a 5-minute window for a write that never landed.
    // The prior reservation (last successful write) is restored; if another
    // admitted write already replaced it, the newer reservation is left alone.
    if (admitted && lastSnapshotTimes.get(source) === now) {
      if (previousReservation === undefined) {
        lastSnapshotTimes.delete(source);
      } else {
        lastSnapshotTimes.set(source, previousReservation);
      }
    }
    console.error(`[Redis] Failed to snapshot ${source}:`, error);
    throw new Error(SNAPSHOT_WRITE_FAILED, { cause: error });
  }
}

/**
 * Convenience method to read a JSON payload from Redis.
 */
export async function getLiveSnapshot(source: string) {
  const key = `data:${source}:live`;
  // Only the Redis GET can fail here. A clean miss (no key) returns null; an
  // operational Redis failure throws a distinguishable marker so callers can
  // 503 instead of mistaking an outage for a missing snapshot (404).
  let data: Buffer | null;
  try {
    // We must use getBuffer natively in ioredis to prevent it from coercing raw bytes to a utf8 string
    data = await redis.getBuffer(key);
  } catch (error) {
    console.error(`[Redis] Failed to get live snapshot ${source}:`, error);
    throw new Error('redis-unavailable', { cause: error });
  }
  if (!data) return null;

  try {
    const decompressed = zlib.unzipSync(data);
    return JSON.parse(decompressed.toString('utf-8'));
  } catch {
    // Fallback if data was stored as plain string before compression was introduced
    return JSON.parse(data.toString('utf-8'));
  }
}
