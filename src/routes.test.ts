import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { routesPlugin, resetRedisHealthCounters } from './routes';
import { seederMeta, seederStatus, registerSeeders, startScheduler } from './scheduler';
import { seederSync, computeSeederSyncOk } from './scripts/download-seeders';
import type { SeederContext, SeederModule } from './seeder-loader';

// Hoisted mock fns so ./redis and ./websocket can be stubbed before the real
// scheduler / routes modules are imported. Seeder metrics come from the REAL
// scheduler module (shared references in seederStatus/seederMeta) so the
// integration path (scheduler -> /health) is genuinely exercised.
const mocks = vi.hoisted(() => ({
  redisPingMock: vi.fn(),
  getLiveSnapshotMock: vi.fn(),
  setLiveSnapshotMock: vi.fn(),
  broadcastSeederStatusMock: vi.fn(),
  broadcastPluginDataMock: vi.fn(),
}));

vi.mock('./redis', () => ({
  redis: { ping: mocks.redisPingMock },
  getLiveSnapshot: mocks.getLiveSnapshotMock,
  setLiveSnapshot: mocks.setLiveSnapshotMock,
}));

vi.mock('./websocket', () => ({
  broadcastPluginData: mocks.broadcastPluginDataMock,
  broadcastSeederStatus: mocks.broadcastSeederStatusMock,
}));

vi.mock('node-cron', () => ({ schedule: vi.fn() }));

function freshSeeder(id: string, fetch: (ctx: SeederContext) => Promise<unknown>): SeederModule {
  return { id, name: id, interval: 1000, fetch };
}

function resetRegistries() {
  for (const key of Object.keys(seederMeta)) delete seederMeta[key];
  for (const key of Object.keys(seederStatus)) delete seederStatus[key];
}

// Reset the shared seederSync object (and the env switch the /health/seeders
// verdict reads) so each test starts from a never-synced engine.
function resetSeederSync() {
  delete process.env.DOWNLOAD_SEEDERS;
  seederSync.ok = null;
  seederSync.lastAttemptAt = null;
  seederSync.community = { ok: false, packages: 0, error: null };
  seederSync.private = { ok: false, packages: 0, error: null };
  seederSync.mergedCount = 0;
}

// Bare Fastify instance wired only to the pure plugin — no rate-limit /
// websocket plugins needed, so the acceptance criteria are isolated.
function buildApp() {
  const app = Fastify();
  app.register(routesPlugin);
  return app;
}

beforeEach(() => {
  vi.useRealTimers();
  resetRegistries();
  resetSeederSync();
  resetRedisHealthCounters();
  mocks.redisPingMock.mockReset();
  mocks.getLiveSnapshotMock.mockReset();
  mocks.setLiveSnapshotMock.mockReset();
  mocks.broadcastSeederStatusMock.mockReset();
  mocks.broadcastPluginDataMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/health — redis liveness + seeder meta truth', () => {
  it('AC-B1: /health returns 200 ok with seeders scalar map + seederMeta when redis.ping resolves', async () => {
    mocks.redisPingMock.mockResolvedValue('PONG');
    seederStatus['mock-seeder'] = 1234567890;
    seederMeta['mock-seeder'] = {
      lastRun: 1234567890,
      lastError: null,
      failureCount: 2,
      itemsSeen: 42,
      intervalMs: null,
      cron: null,
      expectedMaxAgeMs: null,
    };

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.engine).toBe('wwv-data-engine');
    expect(typeof body.timestamp).toBe('number');
    expect(body.redis).toBe('ok');
    // ADDITIVE shape preserved: seeders.<id> stays a scalar timestamp, added seederMeta present.
    expect(typeof body.seeders['mock-seeder']).toBe('number');
    expect(Array.isArray(body.seeders['mock-seeder'])).toBe(false);
    expect(body.seeders['mock-seeder']).toBe(1234567890);
    expect(body.seederMeta['mock-seeder']).toEqual({
      lastRun: 1234567890,
      lastError: null,
      failureCount: 2,
      itemsSeen: 42,
      intervalMs: null,
      cron: null,
      expectedMaxAgeMs: null,
    });
    // The seederHealth section is additive and derived: an id present in
    // seederMeta but with no cadence still yields the full wire shape.
    expect(body.seederHealth['mock-seeder']).toEqual({
      pluginId: 'mock-seeder',
      lastRun: 1234567890,
      lastError: null,
      failureCount: 2,
      intervalMs: null,
      cron: null,
      expectedMaxAgeMs: null,
      stale: false,
    });
  });

  it('AC-B2: a single redis failure still returns 200 ok; 3 consecutive flips to 200 degraded; never 500', async () => {
    mocks.redisPingMock.mockRejectedValue(new Error('connection refused'));
    const app = buildApp();

    // Failure 1 -> still 'ok' (no non-2xx on a single blip).
    let res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().redis).toBe('unreachable');

    // Failure 2 -> still 'ok'.
    res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');

    // Failure 3 -> 'degraded', but STILL 200.
    res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().redis).toBe('unreachable');
  });

  it('AC-B2b: a hanging ping is bounded by the timeout race — /health still returns 200 within the ~target window', async () => {
    vi.useFakeTimers();
    // ping never settles: only the 1500ms timeout race can release the handler.
    mocks.redisPingMock.mockReturnValue(new Promise(() => {}));
    resetRedisHealthCounters();

    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      const pending = app.inject({ method: 'GET', url: '/health' });
      await vi.advanceTimersByTimeAsync(1500); // fire the ping-timeout rejection
      const res = await pending;
      expect(res.statusCode).toBe(200);
    }

    // Fourth hang: still 200, and now reports degraded.
    const pending = app.inject({ method: 'GET', url: '/health' });
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('degraded');
    expect(res.json().redis).toBe('unreachable');

    vi.useRealTimers();
  });
});

describe('snapshot routes — 503 on redis-down vs 404 on clean miss', () => {
  it('AC-B3: getLiveSnapshot throwing redis-unavailable -> 503; resolving null -> 404', async () => {
    const app = buildApp();

    // Redis operationally down -> distinguishable throw -> 503.
    mocks.getLiveSnapshotMock.mockRejectedValue(new Error('redis-unavailable'));
    let res = await app.inject({ method: 'GET', url: '/api/some-seeder' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'redis-unavailable' });

    // Also exercise the backwards-compatible /data/:id alias.
    res = await app.inject({ method: 'GET', url: '/data/some-seeder' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'redis-unavailable' });

    // Clean miss -> null -> 404 preserved.
    mocks.getLiveSnapshotMock.mockResolvedValue(null);
    res = await app.inject({ method: 'GET', url: '/api/some-seeder' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Snapshot not found or seeder not running');
  });

  it('AC-B3b: a successful snapshot still returns the payload (success path untouched)', async () => {
    mocks.getLiveSnapshotMock.mockResolvedValue({ items: [{ a: 1 }] });
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/healthy-seeder' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ a: 1 }] });
  });
});

describe('seeder meta integration through scheduler -> /health', () => {
  it('AC-B4: failure increments failureCount, success sets itemsSeen, and seeders.<id> stays a NUMBER', async () => {
    mocks.redisPingMock.mockResolvedValue('PONG');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // success: itemsSeen=2
      .mockRejectedValueOnce(new Error('boom-b4')); // failure: failureCount++

    vi.useFakeTimers();
    registerSeeders([freshSeeder('seed-b4', fetchMock)]);
    startScheduler();
    // Kickstart = run 1 (success); one interval tick = run 2 (failure).
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.seederMeta['seed-b4'].failureCount).toBe(1);
    expect(body.seederMeta['seed-b4'].itemsSeen).toBe(2);
    expect(body.seederMeta['seed-b4'].lastRun).toBeTypeOf('number');
    // seeders.<id> must remain a Number scalar, not an object.
    expect(typeof body.seeders['seed-b4']).toBe('number');
    expect(Array.isArray(body.seeders['seed-b4'])).toBe(false);
  });

  it('AC-B5: /health seederHealth section exposes the cadence-derived wire contract and cadence-aware stale', async () => {
    mocks.redisPingMock.mockResolvedValue('PONG');
    const fetchMock = vi.fn().mockResolvedValue([{ id: 1 }]);
    const id = 'seed-health-section';

    vi.useFakeTimers();
    registerSeeders([{ id, name: id, interval: 10_000, fetch: fetchMock }]);
    startScheduler();
    await vi.advanceTimersByTimeAsync(0); // kickstart success
    vi.useRealTimers();

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Cadence captured at registration; expectedMaxAgeMs derived from the
    // seeder's OWN 10s interval: max(3 x 10s, floor) = 60s floor.
    expect(body.seederHealth[id]).toEqual({
      pluginId: id,
      lastRun: expect.any(Number),
      lastError: null,
      failureCount: 0,
      intervalMs: 10_000,
      cron: null,
      expectedMaxAgeMs: 60_000,
      stale: false,
    });

    // Drive the lastRun backwards past the derived max age: stale must flip
    // without any global threshold being involved.
    seederMeta[id].lastRun = Date.now() - 120_000;
    const staleRes = await app.inject({ method: 'GET', url: '/health' });
    expect(staleRes.statusCode).toBe(200);
    expect(staleRes.json().seederHealth[id].stale).toBe(true);
    expect(staleRes.json().seederHealth[id].expectedMaxAgeMs).toBe(60_000);
  });
});

describe('GET /health/seeders — 200 vs 503 verdict from the seeder sync state', () => {
  it('AC-C0: /health stays 200 and carries the additive seedersSync field', async () => {
    mocks.redisPingMock.mockResolvedValue('PONG');
    seederSync.lastAttemptAt = 99;
    seederSync.community = { ok: true, packages: 2, error: null };
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().seedersSync).toEqual(seederSync);
  });

  it('AC-C1: 200 with full sync state when sync ok and mergedCount > 0', async () => {
    process.env.DOWNLOAD_SEEDERS = 'true';
    seederSync.ok = true;
    seederSync.lastAttemptAt = 1_234;
    seederSync.community = { ok: true, packages: 12, error: null };
    seederSync.private = { ok: true, packages: 3, error: null };
    seederSync.mergedCount = 15;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/seeders' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      mergedCount: 15,
      community: { ok: true, packages: 12, error: null },
      private: { ok: true, packages: 3, error: null },
      lastAttemptAt: 1_234,
    });
  });

  it('AC-C2: 503 download-disabled when DOWNLOAD_SEEDERS is not exactly true', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/seeders' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'download-disabled' });
  });

  it('AC-C3: 503 not-attempted when lastAttemptAt is null (sync never ran)', async () => {
    process.env.DOWNLOAD_SEEDERS = 'true';
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/seeders' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'not-attempted' });
  });

  it('AC-C4: 503 sync-failed with per-repo errors when a repo failed', async () => {
    process.env.DOWNLOAD_SEEDERS = 'true';
    seederSync.lastAttemptAt = 1_234;
    seederSync.community = { ok: false, packages: 0, error: 'GitHub API returned 401 Unauthorized' };
    seederSync.private = { ok: false, packages: 0, error: 'no GITHUB_PAT' };
    seederSync.mergedCount = 0;

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/seeders' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ok: false,
      reason: 'sync-failed',
      community: { ok: false, packages: 0, error: 'GitHub API returned 401 Unauthorized' },
      private: { ok: false, packages: 0, error: 'no GITHUB_PAT' },
    });
  });

  it('AC-C5: a private skip (no GITHUB_PAT) does NOT fail the sync verdict', async () => {
    process.env.DOWNLOAD_SEEDERS = 'true';
    seederSync.lastAttemptAt = 1_234;
    seederSync.community = { ok: true, packages: 8, error: null };
    seederSync.private = { ok: false, packages: 0, error: 'no GITHUB_PAT' };
    seederSync.mergedCount = 8;
    seederSync.ok = computeSeederSyncOk(seederSync.community, seederSync.private);

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/seeders' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().mergedCount).toBe(8);
  });
});
