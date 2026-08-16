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

/**
 * Converts any casing variant (camelCase, underscore_case, or mixed) to kebab-case.
 * Used to normalise seeder directory names and incoming API request IDs so the
 * engine always speaks the same identifier format as the frontend plugin IDs.
 *
 * @example toKebabCase("civilUnrest")       // "civil-unrest"
 * @example toKebabCase("surveillance_sats") // "surveillance-sats"
 * @example toKebabCase("already-fine")      // "already-fine"
 */
export function toKebabCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '-$1')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/^-/, '');
}

export interface SeederModule {
  id: string;
  name: string;
  interval?: number;
  cron?: string;
  fetch?: (ctx: SeederContext) => Promise<unknown>;
  fn?: (ctx: SeederContext) => Promise<unknown> | void;
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
      results.push({ id: toKebabCase(entry.name), entryPath });
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
      
      // Use the seeder's self-declared name as the canonical plugin ID.
      // This decouples routing from filesystem layout — folder names are
      // organisational only. Fall back to the kebab-cased folder name if
      // the seeder doesn't export a name (shouldn't happen; guarded above).
      const canonicalId =
        typeof seederConfig.name === 'string' && seederConfig.name.length > 0
          ? seederConfig.name
          : id;

      if (canonicalId !== id) {
        console.warn(
          `[SeederLoader] Folder "${id}" exports name "${canonicalId}". ` +
          `Using "${canonicalId}" as the plugin id. ` +
          `Consider renaming the folder to match.`
        );
      }

      seeders.push({
        ...seederConfig,
        id: canonicalId,
      });

      console.log(`[SeederLoader] Discovered seeder: ${canonicalId} (folder: ${id})`);
    } catch (err) {
      console.error(`[SeederLoader] Failed to load seeder ${id}:`, err);
    }
  }
  
  return seeders;
}
