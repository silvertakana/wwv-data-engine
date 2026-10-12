/**
 * Stryker mutation testing configuration.
 *
 * Mutation testing is not part of the pull request gate: a full run takes tens of
 * minutes, so `.github/workflows/mutation-testing.yml` runs it weekly and on demand.
 *
 * Scope: every TypeScript source file under `src`, excluding the test files
 * themselves and the one-off script in `src/scripts`. `coverageAnalysis: "perTest"`
 * means a surviving or killed mutant only re-runs the tests that cover the file it
 * lives in, which is what keeps a run this wide affordable.
 *
 * Thresholds are report-only for now (`break: null`): the first runs exist to measure
 * where the score actually sits. Add a number to `break` once the weekly number is
 * known and someone has agreed on a floor, otherwise the gate starts red on the day it
 * is switched on.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',

  // Stryker's default plugin glob ("@stryker-mutator/*") is resolved relative to the
  // Stryker core package, which under pnpm's isolated node_modules layout lands inside
  // `.pnpm/...` where no runner plugin exists. Naming the runner explicitly is what
  // makes Stryker find it; without this line the run dies with
  // "Cannot find TestRunner plugin \"vitest\"".
  plugins: ['@stryker-mutator/vitest-runner'],

  // Mutation runs use a vitest config with larger per-test timeouts, because
  // instrumenting every module makes the suite several times slower.
  vitest: { configFile: 'vitest.stryker.config.ts' },

  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/scripts/**',
  ],

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },

  thresholds: { high: 80, low: 60, break: null },

  // The websocket tests wait out real 3s auth timeouts; 20s is generous for one
  // instrumented run without letting a hung mutant hold a worker for long.
  timeoutMS: 20000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp', 'node_modules'],

  // The workflow caches this file, so a weekly run only re-tests what changed.
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
};

export default config;
