import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';

// Sanctions are Redis-only (no SQLite table) — live data only
fastify.get('/data/sanctions', async (request, reply) => {
  const liveData = await getLiveSnapshot('sanctions');
  if (liveData) {
    return liveData;
  }
  return {
    id: 'sanctions-live',
    timestamp: null,
    items: []
  };
});
