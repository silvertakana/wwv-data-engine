// src/routes/index.ts
// Auto-discovery: dynamically imports every route file in this directory.
import { readdirSync } from 'fs';
import { join, basename } from 'path';

const routesDir = __dirname;
const files = readdirSync(routesDir).filter(f => {
  const name = basename(f);
  return name !== 'index.ts'
    && name !== 'index.js'
    && (name.endsWith('.ts') || name.endsWith('.js'))
    && !name.endsWith('.d.ts');
});

for (const file of files) {
  require(join(routesDir, file));
}
