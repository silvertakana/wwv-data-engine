import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';
import { globalsTLECache, propagateAll, DEFAULT_GROUPS } from '../seeders/satellite';

fastify.get('/data/satellite', async (request: any, reply) => {
  const { lookback, time, group } = request.query;

  const targetGroups = group ? [group as string] : DEFAULT_GROUPS;

  // Historical playback mode snapshot using TLE on the fly
  if (time && typeof time === 'string') {
    const targetTime = new Date(parseInt(time, 10));
    
    let items: any[] = [];
    const seen = new Set<number>();

    for (const g of targetGroups) {
        const records = globalsTLECache.get(g);
        if (!records) continue;

        const positions = propagateAll(records, targetTime, g);
        for (const p of positions) {
             if (!seen.has(p.noradId)) {
                 items.push(p);
                 seen.add(p.noradId);
             }
        }
    }
    
    return {
        source: "satellite",
        fetchedAt: new Date().toISOString(),
        lookbackSeconds: 0,
        items: items,
        totalCount: items.length
    };
  }

  // 1. Get hot fleet from Redis for current time
  const fleetObj = await getLiveSnapshot('satellite') || {};
  let items = Object.values(fleetObj) as any[];

  if (group) {
      items = items.filter(s => s.group === group);
  }

  return {
    source: "satellite",
    fetchedAt: new Date().toISOString(),
    lookbackSeconds: null,
    items,
    totalCount: items.length
  };
});
