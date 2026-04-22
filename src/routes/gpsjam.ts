import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare('SELECT payload FROM gps_jamming WHERE source_ts >= @start AND source_ts <= @end');

fastify.get('/data/gps_jamming', async (request, reply) => {
  const liveData = await getLiveSnapshot('gps_jamming');
  if (liveData) {
    return liveData;
  }
  return {
    source: "gps_jamming",
    fetchedAt: null,
    items: [],
    totalCount: 0
  };
});

fastify.get('/data/gps_jamming/history', async (request: any, reply) => {
  const { start, end } = request.query;
  if (!start || !end) {
    return reply.status(400).send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }
  const rows = getHistoryQuery.all({ start: parseInt(start, 10), end: parseInt(end, 10) }) as { payload: string }[];
  const historyItems = rows.map(row => JSON.parse(row.payload));
  return {
    source: "gps_jamming",
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length
  };
});
