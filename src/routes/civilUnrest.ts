import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare('SELECT payload FROM civil_unrest WHERE source_ts >= @start AND source_ts <= @end ORDER BY source_ts DESC');

fastify.get('/data/civil_unrest', async (request, reply) => {
  const liveData = await getLiveSnapshot('civil_unrest');
  if (liveData) {
    return { data: liveData };
  }
  return { data: [] };
});

fastify.get('/data/civil_unrest/history', async (request: any, reply) => {
  const { start, end } = request.query;
  if (!start || !end) {
    return reply.status(400).send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }
  const rows = getHistoryQuery.all({ start: parseInt(start, 10), end: parseInt(end, 10) }) as { payload: string }[];
  const historyItems = rows.map(row => JSON.parse(row.payload));
  return {
    source: "civil_unrest",
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length
  };
});
