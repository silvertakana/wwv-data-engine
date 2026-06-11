import { redis, setLiveSnapshot } from './redis';
import type { SeederModule } from './seeder-loader';
import { parseCron, cronMatches, type ParsedCron } from './cron-matcher';

// Registry to hold all registered seeders
let registeredSeeders: SeederModule[] = [];

/**
 * Returns the list of registered plugin/seeder IDs.
 * Used by the /manifest endpoint and WebSocket welcome message.
 */
export function getRegisteredPluginIds(): string[] {
  return registeredSeeders.map(s => s.id);
}

// Registry to track the last run time of each seeder
export const seederStatus: Record<string, number | null> = {};

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
 * How often the shared ticker checks cron schedules. Three checks per
 * minute means a single missed tick (event-loop stall, GC pause) cannot
 * skip a scheduled minute — the next tick inside the same minute catches
 * it, and `lastFiredMinute` keeps it from firing twice.
 *
 * Cron seeders previously each owned a node-cron task; node-cron v3 task
 * chains were observed dying silently in production (2026-06-11: four
 * hourly seeders stopped firing after one ticked alongside a network
 * error, and their snapshots expired into 404s). One plain setInterval
 * over a pure matcher has no per-task chain to lose.
 */
const CRON_TICK_MS = 20_000;

interface ScheduledCronSeeder {
  seeder: SeederModule;
  parsed: ParsedCron;
  run: () => Promise<void>;
  /** Minute key of the last trigger, so each matching minute fires once. */
  lastFiredMinute: string | null;
}

let cronSeeders: ScheduledCronSeeder[] = [];
let intervalHandles: NodeJS.Timeout[] = [];
let cronTicker: NodeJS.Timeout | null = null;

function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
}

function makeCronRunner(seeder: SeederModule): () => Promise<void> {
  return async () => {
    try {
      console.log(`[Scheduler] Running cron seeder: ${seeder.id} ...`);
      // Many legacy plugins handle their own setLiveSnapshot internally
      await seeder.fn!({ redis });
      seederStatus[seeder.id] = Date.now();
    } catch (error: any) {
      console.error(`[Scheduler] Cron Seeder ${seeder.id} failed:`, error.message);
    }
  };
}

/**
 * Run one scheduling pass: fire every cron seeder whose schedule matches
 * `now` and that has not already fired this minute. Exported for tests.
 */
export function cronTick(now: Date = new Date()) {
  const key = minuteKey(now);
  for (const entry of cronSeeders) {
    if (entry.lastFiredMinute === key) continue;
    if (!cronMatches(entry.parsed, now)) continue;
    entry.lastFiredMinute = key;
    void entry.run();
  }
}

/**
 * Start the scheduler. Initializes websocket listeners and registers
 * interval jobs and cron jobs.
 *
 * Every per-seeder step is isolated: a seeder that throws during init or
 * declares a malformed cron expression is logged and skipped, and can
 * never prevent the remaining seeders from being scheduled.
 */
export function startScheduler() {
  console.log('[Scheduler] Starting data engine scheduler...');

  for (const seeder of registeredSeeders) {
    // 1. Run init handlers (like websocket listeners)
    if (seeder.init) {
      console.log(`[Scheduler] Initializing persistent seeder: ${seeder.id}`);
      try {
        seeder.init({ redis });
      } catch (error: any) {
        console.error(`[Scheduler] Init for ${seeder.id} threw — continuing with remaining seeders:`, error.message);
      }
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

            await setLiveSnapshot(seeder.id, {
              source: seeder.id,
              fetchedAt: new Date().toISOString(),
              items: data,
              totalCount: Array.isArray(data) ? data.length : 0
            }, ttlSeconds);
          }

          seederStatus[seeder.id] = Date.now();
        } catch (error: any) {
          console.error(`[Scheduler] Seeder ${seeder.id} failed:`, error.message);
        }
      };

      // Kick off the first run immediately
      console.log(`[Scheduler] Kickstarting initial run for ${seeder.id}...`);
      runSeeder();

      // Schedule interval
      intervalHandles.push(setInterval(runSeeder, seeder.interval));
    }

    // 3. Register cron jobs on the shared ticker
    if (seeder.cron && seeder.fn) {
      let parsed: ParsedCron;
      try {
        parsed = parseCron(seeder.cron);
      } catch (error: any) {
        console.error(`[Scheduler] Invalid cron "${seeder.cron}" for ${seeder.id} — seeder will not run:`, error.message);
        continue;
      }

      console.log(`[Scheduler] Scheduling cron seeder: ${seeder.id} (${seeder.cron})`);
      const entry: ScheduledCronSeeder = {
        seeder,
        parsed,
        run: makeCronRunner(seeder),
        // Pre-stamped with the boot minute so the kickstart below cannot
        // be doubled by a ticker pass in the same minute.
        lastFiredMinute: minuteKey(new Date()),
      };
      cronSeeders.push(entry);

      // Kick off initial run to hydrate data immediately
      console.log(`[Scheduler] Kickstarting initial run for ${seeder.id}...`);
      void entry.run();
    }
  }

  if (cronSeeders.length > 0 && cronTicker === null) {
    cronTicker = setInterval(() => cronTick(), CRON_TICK_MS);
  }
}

/**
 * Stop all timers and clear scheduling state. Used by tests; safe to call
 * during shutdown.
 */
export function stopScheduler() {
  for (const handle of intervalHandles) clearInterval(handle);
  intervalHandles = [];
  if (cronTicker !== null) {
    clearInterval(cronTicker);
    cronTicker = null;
  }
  cronSeeders = [];
}
