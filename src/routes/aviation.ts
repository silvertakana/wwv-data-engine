import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';

/**
 * Live commercial-aircraft positions seeded from OpenSky Network.
 *
 * Returns a flat array — the wwv-plugin-aviation client unpacks both arrays
 * and objects-with-numeric-keys, so either is fine, but array is cleaner.
 *
 * `lookback` and `time` query params are accepted (the plugin sends them
 * for live and playback modes respectively) and currently ignored — we
 * always return the live snapshot. Adding history would require a SQLite
 * table; aviation positions decay so fast that's rarely useful.
 */
fastify.get('/data/aviation', async (_request, _reply) => {
    const snapshot = await getLiveSnapshot('aviation');
    if (Array.isArray(snapshot)) return snapshot;
    return [];
});
