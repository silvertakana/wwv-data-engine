import { fastify } from '../server';
import { getLiveSnapshot } from '../redis';

fastify.get('/data/iss', async (request: any, reply) => {
  try {
    const snapshot = await getLiveSnapshot('iss');
    
    // The Redis payload is wrapped as { "25544": { ... } }
    // The frontend contributor expects a flattened response for the ISS properties
    if (snapshot && snapshot["25544"]) {
        return snapshot["25544"];
    }

    // Fallback if data is missing
    reply.status(404).send({ error: 'ISS telemetry not found or seeder is booting.' });
  } catch (err: any) {
    console.error('[ISS Route] ERROR:', err?.message || err);
    reply.status(500).send({ error: 'Internal error', message: err?.message });
  }
});
