// src/seeders/index.ts
// Auto-discovery: dynamically imports every seeder file in this directory.
// This file is IDENTICAL in both public and private repos — zero merge conflicts.
import { readdirSync } from 'fs';
import { join, basename } from 'path';

const seedersDir = __dirname;
const files = readdirSync(seedersDir).filter(f => {
  const name = basename(f);
  return name !== 'index.ts'
    && name !== 'index.js'
    && (name.endsWith('.ts') || name.endsWith('.js'))
    && !name.endsWith('.d.ts')
    && !name.endsWith('.test.ts');
});

for (const file of files) {
  require(join(seedersDir, file));
}
