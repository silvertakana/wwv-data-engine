/**
 * port-contract.spec.ts
 *
 * Guards the cross-repo port contract between wwv-data-engine and the
 * worldwideview frontend.  If either side drifts, local dev silently routes
 * all plugins to the cloud engine — undetectable without source inspection.
 *
 * What is checked:
 *   1. Engine default PORT literal in src/server.ts
 *   2. Frontend HTTP probe port in worldwideview/src/core/data/engineManifest.ts
 *   3. Frontend WebSocket probe port in worldwideview/src/core/data/resolveEngineUrl.ts
 *   4. README accuracy — must not advertise 5001 as the default port
 *
 * Cross-repo assertions (2 & 3) are skipped automatically when the sibling
 * worldwideview directory is not present (e.g., CI runners that only check out
 * this repo).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a source file relative to the engine repo root. */
function readEngineFile(relPath: string): string {
  const abs = path.resolve(__dirname, '..', relPath);
  return fs.readFileSync(abs, 'utf8');
}

/** Read a source file relative to the sibling worldwideview repo. */
function readFrontendFile(relPath: string): string {
  const abs = path.resolve(__dirname, '..', '..', 'worldwideview', relPath);
  return fs.readFileSync(abs, 'utf8');
}

/** True when the sibling worldwideview repo is present on this machine. */
function frontendRepoPresent(): boolean {
  const abs = path.resolve(__dirname, '..', '..', 'worldwideview');
  return fs.existsSync(abs);
}

/**
 * Extract the first port number that appears in a `localhost:<N>` pattern in
 * the given source text.  Returns null if the pattern is not found.
 */
function extractLocalhostPort(source: string): number | null {
  const match = source.match(/localhost:(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract the default PORT literal from the engine's server.ts.
 * Matches patterns like:  process.env.PORT || '5000'
 *                   or:   process.env.PORT ?? '5000'
 * Returns null if the pattern is not found.
 */
function extractEngineDefaultPort(source: string): number | null {
  // Allow optional whitespace around || or ??; capture the fallback string literal.
  const match = source.match(/process\.env\.PORT\s*(?:\|\||\?\?)\s*['"](\d+)['"]/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Suite 1 — Engine self-check (always runs)
// ---------------------------------------------------------------------------

describe('Engine default port (src/server.ts)', () => {
  it('declares 5000 as the default PORT fallback', () => {
    const source = readEngineFile('src/server.ts');
    const port = extractEngineDefaultPort(source);

    expect(
      port,
      'Could not find the PORT fallback literal in src/server.ts. ' +
      'Expected a line like: parseInt(process.env.PORT || \'5000\', 10)'
    ).not.toBeNull();

    expect(
      port,
      `Engine default port is ${port}, expected 5000. ` +
      'If you changed the default port, update engineManifest.ts and resolveEngineUrl.ts ' +
      'in the worldwideview repo to match, then update this test.'
    ).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Cross-repo contract (skipped when worldwideview is absent)
// ---------------------------------------------------------------------------

describe('Cross-repo port contract (engine ↔ frontend)', () => {
  const SKIP_REASON =
    'worldwideview repo not found at ../worldwideview — ' +
    'skipping cross-repo assertions (safe on isolated CI runners).';

  it('engineManifest.ts HTTP probe matches the engine default port', () => {
    if (!frontendRepoPresent()) {
      console.warn(SKIP_REASON);
      return;
    }

    const engineSource = readEngineFile('src/server.ts');
    const manifestSource = readFrontendFile('src/core/data/engineManifest.ts');

    const enginePort = extractEngineDefaultPort(engineSource);
    const manifestPort = extractLocalhostPort(manifestSource);

    expect(
      manifestPort,
      'Could not find a localhost:<port> literal in engineManifest.ts. ' +
      'Ensure getLocalEngineBase() still uses a hardcoded port number.'
    ).not.toBeNull();

    expect(
      manifestPort,
      `Expected engine default port (${enginePort}) to match frontend probe port ` +
      `(${manifestPort}) in engineManifest.ts. ` +
      'These must be kept in sync or local plugins will silently route to the cloud engine.'
    ).toBe(enginePort);
  });

  it('resolveEngineUrl.ts WebSocket probe matches the engine default port', () => {
    if (!frontendRepoPresent()) {
      console.warn(SKIP_REASON);
      return;
    }

    const engineSource = readEngineFile('src/server.ts');
    const resolveSource = readFrontendFile('src/core/data/resolveEngineUrl.ts');

    const enginePort = extractEngineDefaultPort(engineSource);
    const resolvePort = extractLocalhostPort(resolveSource);

    expect(
      resolvePort,
      'Could not find a localhost:<port> literal in resolveEngineUrl.ts. ' +
      'Ensure getLocalWsUrl() still uses a hardcoded port number.'
    ).not.toBeNull();

    expect(
      resolvePort,
      `Expected engine default port (${enginePort}) to match frontend WebSocket probe port ` +
      `(${resolvePort}) in resolveEngineUrl.ts. ` +
      'These must be kept in sync or local plugins will silently route to the cloud engine.'
    ).toBe(enginePort);
  });

  it('all three port references agree with each other', () => {
    if (!frontendRepoPresent()) {
      console.warn(SKIP_REASON);
      return;
    }

    const enginePort   = extractEngineDefaultPort(readEngineFile('src/server.ts'));
    const manifestPort = extractLocalhostPort(readFrontendFile('src/core/data/engineManifest.ts'));
    const resolvePort  = extractLocalhostPort(readFrontendFile('src/core/data/resolveEngineUrl.ts'));

    const allPorts = { 'server.ts': enginePort, 'engineManifest.ts': manifestPort, 'resolveEngineUrl.ts': resolvePort };
    const unique = new Set(Object.values(allPorts).filter(Boolean));

    expect(
      unique.size,
      `Port mismatch across repos: ${JSON.stringify(allPorts)}. ` +
      'All three files must agree on the same port number. ' +
      'Fix by aligning them to the engine\'s process.env.PORT default.'
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — README accuracy
// ---------------------------------------------------------------------------

describe('README port documentation', () => {
  it('does not advertise 5001 as the default engine port', () => {
    const readme = readEngineFile('README.md');

    // Find every line that mentions 5001 in a "default" context.
    // We look for the ENV table row for PORT (contains "5001") and the
    // prose line that says "starts at http://localhost:5001".
    const lines = readme.split('\n');
    const driftLines = lines
      .map((line, idx) => ({ line, lineNo: idx + 1 }))
      .filter(({ line }) =>
        /5001/.test(line) &&
        // Only flag lines that are presenting 5001 as a default or start URL,
        // not lines that might legitimately reference it as a non-default value.
        /default|localhost:5001|starts at/i.test(line)
      );

    expect(
      driftLines,
      `README.md mentions 5001 as the default port on the following lines:\n` +
      driftLines.map(({ lineNo, line }) => `  Line ${lineNo}: ${line.trim()}`).join('\n') +
      '\n\nThe actual default in src/server.ts is 5000. ' +
      'Update README.md to match (change 5001 → 5000 in the prose and the ENV table).'
    ).toHaveLength(0);
  });
});
