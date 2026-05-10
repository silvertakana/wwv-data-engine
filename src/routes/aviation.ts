import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';

/**
 * Live commercial-aircraft positions seeded from OpenSky Network.
 *
 * Returns `{ source, fetchedAt, items }` to match the wwv-plugin-aviation
 * REST contract (its `fetch()` reads `response.items`). Other engine
 * routes (wildfires, earthquakes, etc.) also use this shape — aviation
 * was previously inconsistent and silently delivered 0 entities to the
 * plugin, which then wiped any data the WS push had already delivered.
 *
 * `lookback` and `time` query params are accepted (the plugin sends them
 * for live and playback modes respectively) and currently ignored — we
 * always return the live snapshot.
 */
fastify.get('/data/aviation', async (_request, _reply) => {
    const snapshot = await getLiveSnapshot('aviation');
    const items = Array.isArray(snapshot) ? snapshot : [];
    return {
        source: 'aviation',
        fetchedAt: new Date().toISOString(),
        items,
        totalCount: items.length,
    };
});
