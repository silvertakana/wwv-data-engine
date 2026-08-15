import { redis, setLiveSnapshot } from './redis';
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
          seederStatus[seeder.id] = Date.now();
        } catch (error: any) {
          console.error(`[Scheduler] Cron Seeder ${seeder.id} failed:`, error.message);
        }
      };

      // Kick off initial run to hydrate data immediately
      console.log(`[Scheduler] Kickstarting initial run for ${seeder.id}...`);
      runCronSeeder();

      cron.schedule(seeder.cron, runCronSeeder);
    }
  }
}
