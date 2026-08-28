import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { routesPlugin, resetRedisHealthCounters } from './routes';
import { seederMeta, seederStatus, registerSeeders, startScheduler } from './scheduler';
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
    seederMeta['mock-seeder'] = { lastRun: 1234567890, lastError: null, failureCount: 2, itemsSeen: 42 };

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
});
