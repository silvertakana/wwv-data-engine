import { readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// By default look for 'seeders' in the CWD (useful for volume mounting), fallback to '../seeders'
const SEEDERS_DIR = process.env.SEEDERS_DIR || resolve(process.cwd(), 'seeders');

export interface SeederModule {
  id: string;
  name: string;
  interval?: number;
  cron?: string;
  fetch?: (ctx: any) => Promise<any>;
  init?: (ctx: any) => void;
}

export async function discoverSeeders(): Promise<SeederModule[]> {
  if (!existsSync(SEEDERS_DIR)) {
    console.warn(`[SeederLoader] Seeders directory not found at: ${SEEDERS_DIR}`);
    return [];
  }

  const dirs = readdirSync(SEEDERS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());
  
  const seeders: SeederModule[] = [];
  
  for (const dir of dirs) {
    const entryPath = join(SEEDERS_DIR, dir.name, 'seeder.mjs');
    
    if (existsSync(entryPath)) {
      try {
        // Dynamic import of the seeder module
        // We use file:// prefix to ensure compatibility on Windows and Linux
        const mod = await import(`file://${entryPath}`);
        
        const seederConfig = mod.default || mod;
        
        seeders.push({
          id: dir.name,
          ...seederConfig,
        });
        
        console.log(`[SeederLoader] Discovered seeder: ${dir.name} (${seederConfig.name})`);
      } catch (err) {
        console.error(`[SeederLoader] Failed to load seeder ${dir.name}:`, err);
      }
    }
  }
  
  return seeders;
}
