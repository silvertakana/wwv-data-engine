import { describe, expect, it } from 'vitest';
import { computeSeederSyncOk, type SeederSyncState } from './scripts/download-seeders';
import { evaluateSeederSyncHealth } from './seeder-sync-health';

const OK_COMMUNITY = { ok: true, packages: 3, error: null };
const OK_PRIVATE = { ok: true, packages: 2, error: null };
const SKIPPED_PRIVATE = { ok: false, packages: 0, error: 'no GITHUB_PAT' };
const FAILED_COMMUNITY = { ok: false, packages: 0, error: 'GitHub API returned 403 Forbidden' };

function state(overrides: Partial<SeederSyncState> = {}): SeederSyncState {
  return {
    ok: null,
    lastAttemptAt: null,
    community: { ...OK_COMMUNITY },
    private: { ...OK_PRIVATE },
    mergedCount: 5,
    ...overrides,
  };
}

describe('computeSeederSyncOk — merge rule for the two-repo sync verdict', () => {
  it('both repos ok -> ok', () => {
    expect(computeSeederSyncOk(OK_COMMUNITY, OK_PRIVATE)).toBe(true);
  });

  it('community ok + private skipped (no GITHUB_PAT) -> ok', () => {
    expect(computeSeederSyncOk(OK_COMMUNITY, SKIPPED_PRIVATE)).toBe(true);
  });

  it('community ok + private genuinely failed -> not ok', () => {
    expect(computeSeederSyncOk(OK_COMMUNITY, { ok: false, packages: 0, error: '401 Unauthorized' })).toBe(false);
  });

  it('community failed -> not ok even when private succeeded', () => {
    expect(computeSeederSyncOk(FAILED_COMMUNITY, OK_PRIVATE)).toBe(false);
  });
});

describe('evaluateSeederSyncHealth — /health/seeders 200/503 verdict', () => {
  it('download-disabled wins even when the sync state looks healthy', () => {
    const result = evaluateSeederSyncHealth(false, state({ ok: true, lastAttemptAt: 1, mergedCount: 5 }));
    expect(result.status).toBe(503);
    if (result.status === 503) {
      expect(result.body).toEqual({ ok: false, reason: 'download-disabled' });
    }
  });

  it('not-attempted when lastAttemptAt is null (sync never ran)', () => {
    const result = evaluateSeederSyncHealth(true, state());
    expect(result.status).toBe(503);
    if (result.status === 503) {
      expect(result.body).toEqual({ ok: false, reason: 'not-attempted' });
    }
  });

  it('sync-failed with per-repo errors when the community repo failed', () => {
    const result = evaluateSeederSyncHealth(true, state({
      ok: false,
      lastAttemptAt: 1,
      community: FAILED_COMMUNITY,
      private: SKIPPED_PRIVATE,
      mergedCount: 0,
    }));
    expect(result.status).toBe(503);
    if (result.status === 503) {
      expect(result.body).toEqual({
        ok: false,
        reason: 'sync-failed',
        community: FAILED_COMMUNITY,
        private: SKIPPED_PRIVATE,
      });
    }
  });

  it('sync-failed when ok but mergedCount is 0 (nothing delivered to serve)', () => {
    const result = evaluateSeederSyncHealth(true, state({ ok: true, lastAttemptAt: 1, mergedCount: 0 }));
    expect(result.status).toBe(503);
    if (result.status === 503) {
      expect(result.body).toMatchObject({ ok: false, reason: 'sync-failed' });
    }
  });

  it('200 with the full sync state when ok and mergedCount > 0', () => {
    const result = evaluateSeederSyncHealth(true, state({ ok: true, lastAttemptAt: 42, mergedCount: 5 }));
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body).toEqual({
        ok: true,
        mergedCount: 5,
        community: OK_COMMUNITY,
        private: OK_PRIVATE,
        lastAttemptAt: 42,
      });
    }
  });
});