import { db } from '../db';
import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';
import crypto from 'crypto';

interface ConflictEvent {
  id: string;
  latitude: number;
  longitude: number;
  type: string;
  subType: string;
  actor1: string;
  actor2: string;
  fatalities: number;
  date: string;
  source: string;
  notes: string;
}

const CONFLICT_HOTSPOTS = [
  { lat: 48.3794, lon: 31.1656, radius: 5 }, // Ukraine
  { lat: 31.0461, lon: 34.8516, radius: 2 }, // Israel/Gaza
  { lat: 15.5007, lon: 32.5599, radius: 6 }, // Sudan
  { lat: 15.3694, lon: 44.1910, radius: 3 }, // Yemen
  { lat: 14.4974, lon: 14.4524, radius: 8 }, // Sahel region
  { lat: 16.8661, lon: 96.1951, radius: 5 }, // Myanmar
  { lat: 5.1521, lon: 46.1996, radius: 4 },  // Somalia
];

const EVENT_TYPES = [
  'Battles',
  'Explosions/Remote violence',
  'Violence against civilians',
  'Protests',
  'Riots',
  'Strategic developments'
];

const WEAPON_TYPES = [
  'Artillery',
  'Airstrike',
  'Drone strike',
  'Armed clashes',
  'IED',
  'Small arms'
];

function generateMockConflictEvents(): ConflictEvent[] {
  const events: ConflictEvent[] = [];
  const today = new Date().toISOString().split('T')[0];

  for (const hotspot of CONFLICT_HOTSPOTS) {
    const numEvents = Math.floor(Math.random() * 10) + 5; // 5-15 events per hotspot
    
    for (let i = 0; i < numEvents; i++) {
        const u = Math.random();
        const v = Math.random();
        const w = hotspot.radius / 111.0; 
        const t = 2 * Math.PI * v;
        const x = w * Math.cos(t);
        const y = w * Math.sin(t);
        
        const lat = hotspot.lat + y;
        const lon = hotspot.lon + x;
        const type = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
        const subType = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
        const fatalities = Math.floor(Math.random() * 10) === 0 ? Math.floor(Math.random() * 50) : Math.floor(Math.random() * 5); // mostly small, some mass
        
        events.push({
            id: crypto.randomUUID(),
            latitude: lat,
            longitude: lon,
            type,
            subType,
            actor1: 'Unidentified Armed Group',
            actor2: 'State Forces',
            fatalities,
            date: today,
            source: 'Mock ACLED Data',
            notes: 'Reported ' + type.toLowerCase() + ' involving ' + subType.toLowerCase() + '.'
        });
    }
  }

  return events;
}

const insertStmt = db.prepare('INSERT OR REPLACE INTO conflict_events (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)');

export async function fetchConflictEvents() {
  console.log('[Seeder: ConflictEvents] Mocking ACLED data generation...');
  const events = generateMockConflictEvents();

  const now = Date.now();
  let inserted = 0;
  
  const insertMany = db.transaction((rows: any[]) => {
      for (const row of rows) {
          insertStmt.run(row);
          inserted++;
      }
  });

  const dbRows = events.map(e => ({
      id: e.id,
      payload: JSON.stringify(e),
      source_ts: now,
      fetched_at: now
  }));
  
  insertMany(dbRows);
  console.log('[Seeder: ConflictEvents] Inserted ' + inserted + ' events into DB.');

  try {
      const geoEntities = events.map(e => ({
          id: 'conflict-' + e.id,
          latitude: e.latitude,
          longitude: e.longitude,
          properties: {
              type: e.type,
              subType: e.subType,
              fatalities: e.fatalities,
              actor1: e.actor1,
              actor2: e.actor2,
              date: e.date,
              notes: e.notes
          }
      }));
      
      await setLiveSnapshot('conflict_events', geoEntities, 3600 * 24); // Cache for 24 hours
  } catch (err) {
      console.warn('[Seeder: ConflictEvents] Redis cache failed:', err);
  }
}

registerSeeder({
    name: 'conflictEvents',
    cron: '0 0 * * *', // Run daily at midnight
    fn: fetchConflictEvents
});
