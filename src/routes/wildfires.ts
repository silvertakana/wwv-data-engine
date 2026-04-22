import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare('SELECT payload FROM wildfires WHERE source_ts >= @start AND source_ts <= @end');

// Standard live endpoint -> returns Redis snapshot
fastify.get('/data/wildfires', async (request, reply) => {
  const liveData = await getLiveSnapshot('wildfires');
  if (liveData) {
    return liveData;
  }
  return {
    source: "wildfires",
    fetchedAt: null,
    items: [],
    totalCount: 0
  };
});

// Full history endpoint -> queries SQLite
fastify.get('/data/wildfires/history', async (request: any, reply) => {
  const { start, end } = request.query;
  
  if (!start || !end) {
    return reply.status(400).send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }

  const rows = getHistoryQuery.all({ start: parseInt(start, 10), end: parseInt(end, 10) }) as { payload: string }[];
  const historyItems = rows.map(row => JSON.parse(row.payload));
  
  return {
    source: "wildfires",
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length
  };
});
