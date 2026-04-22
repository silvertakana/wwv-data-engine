import { fastify } from '../server';
import { db } from '../db';
import { getLiveSnapshot } from '../redis';

const getHistoryQuery = db.prepare(
  'SELECT payload FROM cyber_attacks WHERE source_ts >= @start AND source_ts <= @end ORDER BY source_ts DESC'
);

// Standard live endpoint → returns Redis snapshot
fastify.get('/data/cyber_attacks', async (request, reply) => {
  const liveData = await getLiveSnapshot('cyber_attacks');
  if (liveData) {
    return liveData;
  }
  return {
    source: 'cyber_attacks',
    fetchedAt: null,
    items: [],
    totalCount: 0,
  };
});

// History endpoint → queries SQLite
fastify.get('/data/cyber_attacks/history', async (request: any, reply) => {
  const { start, end } = request.query;

  if (!start || !end) {
    return reply
      .status(400)
      .send({ error: 'Missing start or end query params (Unix timestamps in ms)' });
  }

  const rows = getHistoryQuery.all({
    start: parseInt(start, 10),
    end: parseInt(end, 10),
  }) as { payload: string }[];
  const historyItems = rows.map((row) => JSON.parse(row.payload));

  return {
    source: 'cyber_attacks',
    timeRange: { start: parseInt(start, 10), end: parseInt(end, 10) },
    items: historyItems,
    totalCount: historyItems.length,
  };
});
