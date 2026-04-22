import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare('SELECT payload FROM earthquakes WHERE source_ts >= @start AND source_ts <= @end ORDER BY source_ts DESC');

// Standard live endpoint -> returns Redis snapshot
fastify.get('/data/earthquakes', async (request, reply) => {
  const liveData = await getLiveSnapshot('earthquakes');
  if (liveData) {
    return liveData;
  }
  return {
    source: "earthquakes",
    fetchedAt: null,
    items: [],
    totalCount: 0
  };
});

// Full history endpoint -> queries SQLite
fastify.get('/data/earthquakes/history', async (request: any, reply) => {
  const { start, end } = request.query;
  
  if (!start || !end) {
    return reply.status(400).send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }

  const rows = getHistoryQuery.all({ start: parseInt(start, 10), end: parseInt(end, 10) }) as { payload: string }[];
  const historyItems = rows.map(row => JSON.parse(row.payload));
  
  return {
    source: "earthquakes",
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length
  };
});
