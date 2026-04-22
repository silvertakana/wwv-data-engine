import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare('SELECT payload FROM conflict_events WHERE source_ts >= @start AND source_ts <= @end ORDER BY source_ts DESC');

fastify.get('/data/conflict_events', async (request, reply) => {
  const liveData = await getLiveSnapshot('conflict_events');
  if (liveData) {
    return { data: liveData };
  }
  return { data: [] };
});

fastify.get('/data/conflict_events/history', async (request: any, reply) => {
  const { start, end } = request.query;
  if (!start || !end) {
    return reply.status(400).send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }
  const rows = getHistoryQuery.all({ start: parseInt(start, 10), end: parseInt(end, 10) }) as { payload: string }[];
  const historyItems = rows.map(row => JSON.parse(row.payload));
  return {
    source: "conflict_events",
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length
  };
});
