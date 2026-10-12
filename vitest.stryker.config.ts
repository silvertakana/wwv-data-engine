import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Config used only by the mutation testing run (see `stryker.config.mjs`).
 *
 * Stryker instruments every module before the tests execute, which makes the suite
 * several times slower than a plain `pnpm test`. The defaults that keep the regular
 * suite honest (5s per test) kill instrumented tests that legitimately take longer -
 * `cronPeriodMs` walks a multi-year cron window, and the websocket tests wait out real
 * 3s auth timeouts. The mutation run therefore gets its own config with headroom;
 * everything except the timeouts is inherited from `vitest.config.ts`.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 30_000,
      hookTimeout: 30_000,
      teardownTimeout: 30_000,
    },
  }),
);
