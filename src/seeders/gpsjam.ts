import { db } from '../db';
import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';
import { randomUUID } from 'crypto';

const insertGpsJam = db.prepare('INSERT OR REPLACE INTO gps_jamming (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)');

const HOTSPOTS = [
  { name: 'Eastern Europe / Ukraine', lat: 48.0, lon: 37.0, radiusDeg: 5, intensity: 'high' },
  { name: 'Baltic Sea Region', lat: 58.0, lon: 20.0, radiusDeg: 4, intensity: 'high' },
  { name: 'Middle East', lat: 33.0, lon: 36.0, radiusDeg: 6, intensity: 'high' },
  { name: 'Black Sea', lat: 43.0, lon: 34.0, radiusDeg: 3, intensity: 'medium' },
  { name: 'Korean Peninsula', lat: 38.0, lon: 127.0, radiusDeg: 2, intensity: 'medium' },
];

function generateMockData() {
  const items = [];
  const now = Date.now();
  
  for (const hotspot of HOTSPOTS) {
    // Generate 50-150 points per hotspot
    const count = Math.floor(Math.random() * 100) + 50;
    
    for (let i = 0; i < count; i++) {
        // Random offset within radius using somewhat normal distribution
        const u = Math.random() + Math.random() - 1; 
        const v = Math.random() + Math.random() - 1;
        
        const lat = hotspot.lat + (u * hotspot.radiusDeg);
        const lon = hotspot.lon + (v * hotspot.radiusDeg);
        
        // Intensity decreases slightly away from center
        const distFromCenter = Math.sqrt(u*u + v*v);
        let pointIntensity = hotspot.intensity;
        
        if (hotspot.intensity === 'high' && distFromCenter > 0.6) {
             pointIntensity = 'medium';
        }
        if (pointIntensity === 'medium' && distFromCenter > 0.8) {
             pointIntensity = 'low';
        }

        items.push({
            id: randomUUID(),
            lat,
            lon,
            interferenceLevel: pointIntensity,
            timestamp: now,
            region: hotspot.name
        });
    }
  }
  return items;
}

export async function seedGpsJam() {
  console.log('[GPS Jamming] Generating daily interference map snapshot...');
  
  const fetchedAt = Date.now();
  const sourceTs = fetchedAt; // Represents end of the 24h period for the map
  const items = generateMockData();

  let insertedCount = 0;
  
  db.transaction(() => {
     // Optional: clear old data to keep DB size small if this is just a daily map
     db.exec('DELETE FROM gps_jamming');

     for (const item of items) {
        const result = insertGpsJam.run({
            id: item.id,
            payload: JSON.stringify(item),
            source_ts: sourceTs,
            fetched_at: fetchedAt
        });
        if (result.changes > 0) insertedCount++;
     }
  })();

  console.log(`[GPS Jamming] Generated ${items.length} points. Saved ${insertedCount} to SQLite.`);

  // Save to Redis Live Cache
  await setLiveSnapshot('gps_jamming', {
    source: "gpsjam_mock",
    fetchedAt: new Date().toISOString(),
    items: items,
    totalCount: items.length
  }, 86400); // 24 hours TTL
}

registerSeeder({
  name: "gps_jamming",
  cron: "0 0 * * *", // Once daily at midnight
  fn: seedGpsJam
});
