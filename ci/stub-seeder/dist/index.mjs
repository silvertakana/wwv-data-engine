// CI-only stub seeder. Emits a known-good GeoEntity[] under STUB_PLUGIN_ID.
// When STUB_PLUGIN_ID is unset it exports a nameless module so the seeder
// loader SKIPS it (must never crash the shared :ci engine in seeder-CI).
// Source of truth: worldwideview/docker/ci/stub-seeder. Keep in sync.
//
// Uses the interval+fetch seeder contract: fetch() simply RETURNS the array
// and the scheduler auto-wraps it into a snapshot and stores it under the
// seeder id (= directory name). The cron+fn contract would require calling the
// engine-internal setLiveSnapshot, which is NOT exposed on the seeder ctx
// (ctx is only { redis }) — calling ctx.setLiveSnapshot throws and the snapshot
// never lands, so the probe receives nothing.

const pluginId = process.env.STUB_PLUGIN_ID;

function makeEntities() {
  const now = new Date().toISOString();
  return [
    { id: `${pluginId}-stub-1`, pluginId, latitude: 0, longitude: 0, altitude: 0, timestamp: now, label: "Stub entity 1", properties: { source: "ci-stub" } },
    { id: `${pluginId}-stub-2`, pluginId, latitude: 10, longitude: 10, altitude: 0, timestamp: now, label: "Stub entity 2", properties: { source: "ci-stub" } },
  ];
}

export default pluginId
  ? {
      name: pluginId,
      interval: 10000,
      fetch: async () => {
        const entities = makeEntities();
        console.log(`[stub-seeder] emitting ${entities.length} entities for ${pluginId}`);
        return entities;
      },
    }
  : {};
