import { readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type Redis from 'ioredis';

// By default look for 'seeders' in the CWD (useful for volume mounting), fallback to '../seeders'
const SEEDERS_DIR = process.env.SEEDERS_DIR || resolve(process.cwd(), 'seeders');

/**
 * The ONLY object a seeder receives at runtime. It is intentionally just the
 * Redis client — there is no `setLiveSnapshot` (or any other helper) on it.
 *
 * To publish data, pick one of the two supported shapes (see README →
 * "Authoring a Seeder"):
 *   - interval + fetch: just RETURN the array; the scheduler wraps it into a
 *     snapshot and stores it for you. No publishing call needed.
 *   - cron + fn: import { setLiveSnapshot } from '@worldwideview/seeder-sdk'
 *     and call it yourself. Do NOT reach for ctx.setLiveSnapshot — it does not
 *     exist, and this type exists to make that mistake a compile error.
 */
export interface SeederContext {
  redis: Redis;
}

export interface SeederModule {
  id: string;
  name: string;
  interval?: number;
  cron?: string;
  fetch?: (ctx: SeederContext) => Promise<any>;
  fn?: (ctx: SeederContext) => Promise<any> | void;
  init?: (ctx: SeederContext) => void;
}

function findSeederEntryPaths(baseDir: string, depth = 0): { id: string, entryPath: string }[] {
  // Prevent infinite recursion, max depth 3 should cover /community/packages/<seeder>
  if (depth > 3) return [];
  if (!existsSync(baseDir)) return [];

  console.log(`[SeederLoader] Scanning directory: ${baseDir}`);
  const results: { id: string, entryPath: string }[] = [];
  const entries = readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const dirPath = join(baseDir, entry.name);
    
    // Check if this dir is a seeder
    const entryMjs = join(dirPath, 'dist', 'index.mjs');
    const entryJs = join(dirPath, 'dist', 'index.js');
    const seederMjs = join(dirPath, 'seeder.mjs');
    
    let entryPath: string | null = null;
    if (existsSync(entryMjs)) {
      entryPath = entryMjs;
    } else if (existsSync(entryJs)) {
      entryPath = entryJs;
    } else if (existsSync(seederMjs)) {
      entryPath = seederMjs;
    }

    if (entryPath) {
      results.push({ id: entry.name, entryPath });
    } else {
      // If not a seeder, maybe it's a group (like 'community', 'private', 'packages')
      results.push(...findSeederEntryPaths(dirPath, depth + 1));
    }
  }

  return results;
}

export async function discoverSeeders(): Promise<SeederModule[]> {
  if (!existsSync(SEEDERS_DIR)) {
    console.warn(`[SeederLoader] Seeders directory not found at: ${SEEDERS_DIR}`);
    return [];
  }

  const seederFiles = findSeederEntryPaths(SEEDERS_DIR);
  const seeders: SeederModule[] = [];
  
  for (const { id, entryPath } of seederFiles) {
    try {
      // Dynamic import of the seeder module
      // We use file:// prefix to ensure compatibility on Windows and Linux
      const mod = await import(`file://${entryPath}`);
      
      const seederConfig = mod.default || mod;
      
      if (!seederConfig || !seederConfig.name) {
        console.log(`[SeederLoader] Skipping ${id}: not a valid seeder module`);
        continue;
      }
      
      seeders.push({
        ...seederConfig,
        id,
      });
      
      console.log(`[SeederLoader] Discovered seeder: ${id} (${seederConfig.name})`);
    } catch (err) {
      console.error(`[SeederLoader] Failed to load seeder ${id}:`, err);
    }
  }
  
  return seeders;
}
