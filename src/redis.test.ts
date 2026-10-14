import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';

// Credential-free synthetic fixture. It is assigned before the redis module is
// imported (vi.hoisted runs ahead of the hoisted imports) so no inherited
// REDIS_URL from the surrounding shell can be picked up. dotenv is mocked, so
// no .env.local file is opened and no real connection string is read or logged.
const SYNTHETIC_REDIS_URL = 'redis://127.0.0.1:6399/0';
const SNAPSHOT_THROTTLE_MS = 5 * 60 * 1000;

const {
  redisSetMock,
  redisGetBufferMock,
  redisOnMock,
  redisConstructorMock,
  broadcastPluginDataMock,
} = vi.hoisted(() => {
  process.env.REDIS_URL = 'redis://127.0.0.1:6399/0';
  return {
    redisSetMock: vi.fn(),
    redisGetBufferMock: vi.fn(),
    redisOnMock: vi.fn(),
    redisConstructorMock: vi.fn(),
    broadcastPluginDataMock: vi.fn(),
  };
});

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

vi.mock('ioredis', () => {
  class MockRedis {
    constructor(...args: unknown[]) {
      redisConstructorMock(...args);
    }
    on(...args: unknown[]) {
      redisOnMock(...args);
      return this;
    }
    set(...args: unknown[]) {
      return redisSetMock(...args);
    }
    getBuffer(...args: unknown[]) {
      return redisGetBufferMock(...args);
    }
  }
  return { default: MockRedis, Redis: MockRedis };
});

vi.mock('./websocket', () => ({ broadcastPluginData: broadcastPluginDataMock }));

import { SNAPSHOT_WRITE_FAILED, setLiveSnapshot } from './redis';

function payloadFor(tag: string) {
  return { source: 'fixture', fetchedAt: '2026-10-15T00:00:00.000Z', items: [tag] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
  redisSetMock.mockReset().mockResolvedValue('OK');
  redisGetBufferMock.mockReset().mockResolvedValue(null);
  broadcastPluginDataMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setLiveSnapshot write outcomes', () => {
  it('resolves on a completed write and keeps gzip, TTL and meta-key semantics', async () => {
    const payload = payloadFor('done');

    await expect(setLiveSnapshot('src-write', payload, 600)).resolves.toBeUndefined();

    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(1);
    expect(broadcastPluginDataMock).toHaveBeenCalledWith('src-write', payload);

    expect(redisSetMock).toHaveBeenCalledTimes(2);
    const dataCall = redisSetMock.mock.calls[0];
    expect(dataCall[0]).toBe('data:src-write:live');
    expect(Buffer.isBuffer(dataCall[1])).toBe(true);
    expect(JSON.parse(zlib.gunzipSync(dataCall[1] as Buffer).toString('utf-8'))).toEqual(payload);
    expect(dataCall.slice(2)).toEqual(['EX', 600]);

    const metaCall = redisSetMock.mock.calls[1];
    expect(metaCall[0]).toBe('meta:src-write:last_run');
    expect(Number.isNaN(Number(metaCall[1]))).toBe(false);
    expect(metaCall.slice(2)).toEqual(['EX', 1200]);
  });

  it('resolves and skips the Redis write inside the 5-minute window while still broadcasting', async () => {
    await setLiveSnapshot('src-throttle', payloadFor('one'), 600);
    redisSetMock.mockClear();
    broadcastPluginDataMock.mockClear();

    await expect(setLiveSnapshot('src-throttle', payloadFor('two'), 600)).resolves.toBeUndefined();

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(1);
    expect(broadcastPluginDataMock).toHaveBeenCalledWith('src-throttle', payloadFor('two'));
  });

  it('rejects with the stable bounded marker when the data SET fails and keeps the cause internal', async () => {
    const raw = new Error('connect ECONNREFUSED redis-host.internal:6379');
    redisSetMock.mockRejectedValueOnce(raw);

    const error = await setLiveSnapshot('src-datafail', payloadFor('x'), 60).then(
      () => {
        throw new Error('expected setLiveSnapshot to reject');
      },
      (rejection: unknown) => rejection as Error,
    );

    expect(error.message).toBe(SNAPSHOT_WRITE_FAILED);
    expect(error.message).toBe('snapshot-write-failed');
    expect(SNAPSHOT_WRITE_FAILED.length).toBeLessThanOrEqual(200);
    expect(error.message).not.toContain('redis-host.internal');
    expect((error as Error & { cause?: unknown }).cause).toBe(raw);
    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(1);
  });

  it('treats a meta SET failure after a successful data SET as a failed publication', async () => {
    redisSetMock.mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('meta write failed'));

    await expect(setLiveSnapshot('src-metafail', payloadFor('m'), 60)).rejects.toThrow(SNAPSHOT_WRITE_FAILED);
    expect(redisSetMock).toHaveBeenCalledTimes(2);
  });

  it('releases the throttle reservation on failure so the next call retries without the 5-minute wait', async () => {
    redisSetMock.mockRejectedValueOnce(new Error('first write failed'));
    await expect(setLiveSnapshot('src-retry', payloadFor('f'), 60)).rejects.toThrow(SNAPSHOT_WRITE_FAILED);

    redisSetMock.mockClear();
    await expect(setLiveSnapshot('src-retry', payloadFor('s'), 60)).resolves.toBeUndefined();
    expect(redisSetMock).toHaveBeenCalledTimes(2);
  });

  it('rejects on serialization failure without writing and lets a later attempt succeed', async () => {
    const circular: Record<string, unknown> = { source: 'circular' };
    circular.self = circular;

    await expect(setLiveSnapshot('src-circular', circular, 60)).rejects.toThrow(SNAPSHOT_WRITE_FAILED);
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(1);

    await expect(setLiveSnapshot('src-circular', payloadFor('ok'), 60)).resolves.toBeUndefined();
    expect(redisSetMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when the websocket broadcast itself throws', async () => {
    broadcastPluginDataMock.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    await expect(setLiveSnapshot('src-bcast', payloadFor('b'), 60)).rejects.toThrow(SNAPSHOT_WRITE_FAILED);
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('suppresses a duplicate write while the first is pending and never clobbers a newer reservation', async () => {
    let rejectFirst!: (reason: Error) => void;
    redisSetMock
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue('OK');

    const first = setLiveSnapshot('src-concurrent', payloadFor('first'), 60);
    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(1);

    await expect(setLiveSnapshot('src-concurrent', payloadFor('second'), 60)).resolves.toBeUndefined();
    expect(broadcastPluginDataMock).toHaveBeenCalledTimes(2);
    expect(redisSetMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_THROTTLE_MS);
    await expect(setLiveSnapshot('src-concurrent', payloadFor('third'), 60)).resolves.toBeUndefined();
    expect(redisSetMock).toHaveBeenCalledTimes(3);

    rejectFirst(new Error('stale write failed'));
    await expect(first).rejects.toThrow(SNAPSHOT_WRITE_FAILED);

    redisSetMock.mockClear();
    await expect(setLiveSnapshot('src-concurrent', payloadFor('fourth'), 60)).resolves.toBeUndefined();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('builds the client from the synthetic fixture, not a real environment value', () => {
    expect(redisConstructorMock).toHaveBeenCalled();
    const [url] = redisConstructorMock.mock.calls[0];
    expect(url).toBe(SYNTHETIC_REDIS_URL);
    expect(String(url)).not.toContain('@');
  });
});
