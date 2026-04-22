import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';

// Surveillance Satellites split route
fastify.get('/data/surveillance_satellites', async (request, reply) => {
  const liveData = await getLiveSnapshot('surveillance_satellites');
  if (liveData) {
    return { satellites: Object.values(liveData) };
  }
  return { satellites: [] };
});
