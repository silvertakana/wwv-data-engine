// CI-only stub seeder. Emits a known-good GeoEntity[] under STUB_PLUGIN_ID.
// When STUB_PLUGIN_ID is unset it exports a nameless module so the seeder
// loader SKIPS it (must never crash the shared :ci engine in seeder-CI).
// Source of truth: worldwideview/docker/ci/stub-seeder. Keep in sync.

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
      cron: "*/10 * * * * *",
      fn: async (ctx) => {
        const entities = makeEntities();
        await ctx.setLiveSnapshot(pluginId, entities, 300);
        console.log(`[stub-seeder] emitted ${entities.length} entities for ${pluginId}`);
      },
    }
  : {};
