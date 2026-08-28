import { redis, setLiveSnapshot } from './redis';
import { broadcastSeederStatus } from './websocket';
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
};

export const seederMeta: Record<string, SeederMeta> = {};

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
    meta = { lastRun: null, lastError: null, failureCount: 0, itemsSeen: 0 };
    seederMeta[id] = meta;
  }
  return meta;
}

function recordSeederSuccess(id: string, fetchedAt: string, itemsSeen: number) {
  seederStatus[id] = Date.now();
  staleActive.set(id, false);
  lastGoodFetchedAt.set(id, fetchedAt);
  const meta = ensureSeederMeta(id);
  meta.lastRun = Date.now();
  meta.lastError = null;
  meta.itemsSeen = itemsSeen;
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
    try {
      broadcastSeederStatus(id, {
        status: 'stale',
        lastGood: lastGoodFetchedAt.get(id) ?? null,
      });
    } catch (broadcastError) {
      // Never let a broadcast failure escape a timer tick and kill the process.
      console.error(`[Scheduler] Failed to broadcast stale status for ${id}:`, broadcastError);
    }
  }
}

/**
 * Register a list of discovered seeders to be scheduled.
 */
export function registerSeeders(seeders: SeederModule[]) {
  registeredSeeders = seeders;
  for (const seeder of seeders) {
    seederStatus[seeder.id] = null;
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
