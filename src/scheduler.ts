import { redis, setLiveSnapshot } from './redis';
import { broadcastSeederStatus } from './websocket';
import { deriveExpectedMaxAgeMs, deriveSeederHealth } from './seeder-health';
import type { SeederHealth } from './seeder-health';
import * as cron from 'node-cron';
import type { SeederModule } from './seeder-loader';

// Registry to hold all registered seeders
let registeredSeeders: SeederModule[] = [];

/**
 * Returns the list of registered plugin/seeder IDs.
 * Used by the /manifest endpoint and WebSocket welcome message.
 */
export function getRegisteredPluginIds(): string[] {
  return registeredSeeders.map(s => s.id);
}

/**
 * Returns the list of registered seeder exported names.
 * Used for development validation and ensuring names match frontend plugin IDs.
 */
export function getRegisteredSeederNames(): string[] {
  return registeredSeeders.map(s => s.name);
}

// Registry to track the last run time of each seeder
export const seederStatus: Record<string, number | null> = {};

// Per-seeder in-memory metric state, exposed to /health by a later change.
export type SeederMeta = {
  lastRun: number | null;
  lastError: string | null;
  failureCount: number;
  itemsSeen: number;
  /** Declared interval cadence in ms; null for cron or unknown-cadence seeders. */
  intervalMs: number | null;
  /** Declared cron expression verbatim; null for interval seeders. */
  cron: string | null;
  /**
   * Per-seeder max snapshot age before stale, derived from the seeder's OWN
   * cadence (see seeder-health.ts): interval seeders max(3x interval, 60s),
   * cron seeders max(cronPeriod + grace, 60s). null when no cadence is
   * declared.
   */
  expectedMaxAgeMs: number | null;
};

export const seederMeta: Record<string, SeederMeta> = {};

/**
 * Wire-contract health payload for one seeder (see seeder-health.ts for the
 * globe-mirrored shape). Computed from seederMeta at call time so `stale`
 * reflects the moment of the /health request or status frame.
 */
export function seederHealthFor(id: string): SeederHealth {
  return deriveSeederHealth(id, ensureSeederMeta(id));
}

/** All known seeders' health payloads, keyed by plugin id. */
export function allSeederHealth(): Record<string, SeederHealth> {
  const out: Record<string, SeederHealth> = {};
  for (const id of Object.keys(seederMeta)) {
    out[id] = seederHealthFor(id);
  }
  return out;
}

// Last-known-good bookkeeping: the most recent successful fetchedAt ISO string
// (stale envelope's lastGood) and whether the seeder is currently reporting
// stale. Used to emit the ok->stale transition frame exactly once per failure
// streak, debounced across intervals.
const lastGoodFetchedAt = new Map<string, string | null>();
const staleActive = new Map<string, boolean>();

const MAX_ERROR_LENGTH = 200;

function ensureSeederMeta(id: string): SeederMeta {
  let meta = seederMeta[id];
  if (!meta) {
    meta = {
      lastRun: null,
      lastError: null,
      failureCount: 0,
      itemsSeen: 0,
      intervalMs: null,
      cron: null,
      expectedMaxAgeMs: null,
    };
    seederMeta[id] = meta;
  }
  return meta;
}

// Broadcast the ok/stale status frame carrying the wire-contract health
// payload. Broadcast failures must never escape a timer tick.
function tryBroadcastSeederStatus(id: string, status: { status: string; lastGood: string | null }, health: SeederHealth) {
  try {
    broadcastSeederStatus(id, { ...status, health });
  } catch (broadcastError) {
    console.error(`[Scheduler] Failed to broadcast status for ${id}:`, broadcastError);
  }
}

function recordSeederSuccess(id: string, fetchedAt: string, itemsSeen: number) {
  seederStatus[id] = Date.now();
  staleActive.set(id, false);
  lastGoodFetchedAt.set(id, fetchedAt);
  const meta = ensureSeederMeta(id);
  meta.lastRun = Date.now();
  meta.lastError = null;
  meta.itemsSeen = itemsSeen;
  // Additive ok frame: same type:'status' wire shape as the stale frame,
  // so subscribers can render recovery + live health without polling /health.
  tryBroadcastSeederStatus(id, { status: 'ok', lastGood: fetchedAt }, seederHealthFor(id));
}

function recordSeederFailure(id: string, error: unknown) {
  const meta = ensureSeederMeta(id);
  meta.lastRun = Date.now();
  meta.failureCount += 1;
  const raw = error instanceof Error ? error.message : String(error);
  meta.lastError = raw.slice(0, MAX_ERROR_LENGTH);

  // Emit a stale frame only on the ok->stale transition. While a seeder stays
  // stale across consecutive failures, this is a no-op.
  if (!staleActive.get(id)) {
    staleActive.set(id, true);
    tryBroadcastSeederStatus(id, {
      status: 'stale',
      lastGood: lastGoodFetchedAt.get(id) ?? null,
    }, seederHealthFor(id));
  }
}

/**
 * Register a list of discovered seeders to be scheduled.
 */
export function registerSeeders(seeders: SeederModule[]) {
  registeredSeeders = seeders;
  for (const seeder of seeders) {
    seederStatus[seeder.id] = null;
    // Capture the seeder's own declared cadence at registration so staleness
    // is derived per-seeder, never from a global threshold.
    const meta = ensureSeederMeta(seeder.id);
    meta.intervalMs = typeof seeder.interval === 'number' ? seeder.interval : null;
    meta.cron = typeof seeder.cron === 'string' ? seeder.cron : null;
    meta.expectedMaxAgeMs = deriveExpectedMaxAgeMs({ intervalMs: seeder.interval, cron: seeder.cron });
  }
}

/**
 * Start the scheduler. Initializes websocket listeners and registers interval jobs.
 */
export function startScheduler() {
  console.log('[Scheduler] Starting data engine scheduler...');
  
  for (const seeder of registeredSeeders) {
    // 1. Run init handlers (like websocket listeners)
    if (seeder.init) {
      console.log(`[Scheduler] Initializing persistent seeder: ${seeder.id}`);
      seeder.init({ redis });
    }
    
    // 2. Schedule interval jobs
    if (seeder.interval && seeder.fetch) {
      console.log(`[Scheduler] Scheduling interval seeder: ${seeder.id} (${seeder.interval}ms)`);
      
      const runSeeder = async () => {
        try {
          console.log(`[Scheduler] Running seeder: ${seeder.id} ...`);
          const data = await seeder.fetch!({ redis });
          
          if (data) {
            // Save payload to Redis & broadcast to WebSocket
            // TTL is usually 2-3x the interval
            const ttlSeconds = Math.max(300, Math.floor((seeder.interval! * 3) / 1000));
            const fetchedAt = new Date().toISOString();

            await setLiveSnapshot(seeder.id, {
              source: seeder.id,
              fetchedAt,
              items: data,
              totalCount: Array.isArray(data) ? data.length : 0
            }, ttlSeconds);

            recordSeederSuccess(seeder.id, fetchedAt, Array.isArray(data) ? data.length : 0);
          } else {
            recordSeederFailure(seeder.id, 'Seeder returned no data');
          }
        } catch (error: unknown) {
          console.error(`[Scheduler] Seeder ${seeder.id} failed:`, error instanceof Error ? error.message : String(error));
          recordSeederFailure(seeder.id, error);
        }
      };
      
      // Kick off the first run immediately
      console.log(`[Scheduler] Kickstarting initial run for ${seeder.id}...`);
      runSeeder();
      
      // Schedule interval
      setInterval(runSeeder, seeder.interval);
    }
    
    // 3. Schedule cron jobs
    if (seeder.cron && seeder.fn) {
      console.log(`[Scheduler] Scheduling cron seeder: ${seeder.id} (${seeder.cron})`);
      
      const runCronSeeder = async () => {
        try {
          console.log(`[Scheduler] Running cron seeder: ${seeder.id} ...`);
          // Many legacy plugins handle their own setLiveSnapshot internally
          await seeder.fn!({ redis });
          // Cron seeders manage their own snapshots, so there is no envelope
          // fetchedAt or item count to derive here; record the run as good
          // against the current timestamp.
          recordSeederSuccess(seeder.id, new Date().toISOString(), 0);
        } catch (error: unknown) {
          console.error(`[Scheduler] Cron Seeder ${seeder.id} failed:`, error instanceof Error ? error.message : String(error));
          recordSeederFailure(seeder.id, error);
        }
      };

      // Kick off initial run to hydrate data immediately
      console.log(`[Scheduler] Kickstarting initial run for ${seeder.id}...`);
      runCronSeeder();

      cron.schedule(seeder.cron, runCronSeeder);
    }
  }
}
