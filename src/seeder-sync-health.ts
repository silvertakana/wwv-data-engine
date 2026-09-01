import type { SeederSyncRepoState, SeederSyncState } from './scripts/download-seeders';

// Verdict for GET /health/seeders. /health itself must ALWAYS stay 200 (a
// separate liveness workflow depends on it); only this endpoint carries the
// 503, so an empty or disabled seeders sync can never take the health probe
// down. Every 503 body carries exactly one machine-readable reason.
export type SeederSyncHealthResult =
  | {
      status: 200;
      body: {
        ok: true;
        mergedCount: number;
        community: SeederSyncRepoState;
        private: SeederSyncRepoState;
        lastAttemptAt: number | null;
      };
    }
  | {
      status: 503;
      body:
        | { ok: false; reason: 'download-disabled' }
        | { ok: false; reason: 'not-attempted' }
        | {
            ok: false;
            reason: 'sync-failed';
            community: SeederSyncRepoState;
            private: SeederSyncRepoState;
          };
    };

// Pure route verdict: precedence is download-disabled, then not-attempted,
// then sync-failed. A sync only counts as healthy once a pass actually ran
// (lastAttemptAt set) and delivered at least one package.
export function evaluateSeederSyncHealth(
  downloadEnabled: boolean,
  sync: SeederSyncState,
): SeederSyncHealthResult {
  if (!downloadEnabled) {
    return { status: 503, body: { ok: false, reason: 'download-disabled' } };
  }
  if (sync.lastAttemptAt === null) {
    return { status: 503, body: { ok: false, reason: 'not-attempted' } };
  }
  if (sync.ok !== true || sync.mergedCount <= 0) {
    return {
      status: 503,
      body: {
        ok: false,
        reason: 'sync-failed',
        community: sync.community,
        private: sync.private,
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      mergedCount: sync.mergedCount,
      community: sync.community,
      private: sync.private,
      lastAttemptAt: sync.lastAttemptAt,
    },
  };
}