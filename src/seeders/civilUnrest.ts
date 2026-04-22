import { db } from '../db';
import { setLiveSnapshot } from '../redis';
import { fetchWithTimeout, withRetry } from '../seed-utils';
import { registerSeeder } from '../scheduler';
import { randomUUID } from 'crypto';

interface GdeltFeature {
  type: string;
  geometry: { type: string, coordinates: number[] };
  properties: {
    urlpubtimedate: string;
    name: string;
    domain: string;
    url: string;
    urltone: number;
  };
}

const GDELT_URL = 'http://api.gdeltproject.org/api/v1/gkg_geojson?query=protest OR riot OR demonstration OR strike OR clash&maxrows=2500';

function classifyGdeltEventType(name: string) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'Riots';
  if (lowerName.includes('clash')) return 'Riots';
  if (lowerName.includes('strike')) return 'Strikes';
  if (lowerName.includes('demonstration')) return 'Demonstrations';
  return 'Protests';
}

function classifyGdeltSubType(name: string, count: number) {
  const lowerName = name.toLowerCase();
  if (count > 50 || lowerName.includes('riot') || lowerName.includes('clash')) return 'Violent demonstration';
  if (lowerName.includes('strike')) return 'Labor strike';
  return 'Peaceful protest';
}

const insertUnrest = db.prepare(
  'INSERT OR REPLACE INTO civil_unrest (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)'
);

export async function seedCivilUnrest() {
  console.log('[CivilUnrest] Fetching from GDELT API...');
  
  const res = await withRetry(() => fetchWithTimeout(GDELT_URL, { headers: { 'User-Agent': 'WWV-Data-Engine' } }, 25000), 3, 5000);
  if (!res.ok) {
        console.warn(`[CivilUnrest] Failed to fetch. HTTP ${res.status}`);
        return;
  }
  
  const json = await res.json();
  const features = json.features as GdeltFeature[];
  
  if (!features || features.length === 0) {
    console.log('[CivilUnrest] No events returned from GDELT.');
    return;
  }

  // Aggregate by location
  const locationMap = new Map<string, any>();
  for (const feature of features) {
    const name = feature.properties?.name || '';
    if (!name) continue;

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    // Grid snap to ~11km clustering
    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      existing.urls.push(feature.properties.url);
      if (feature.properties.urltone < existing.worstTone) {
         existing.worstTone = feature.properties.urltone;
      }
    } else {
      locationMap.set(key, { 
          name, 
          lat, 
          lon, 
          count: 1, 
          worstTone: feature.properties.urltone ?? 0,
          date: feature.properties.urlpubtimedate,
          urls: [feature.properties.url]
      });
    }
  }

  const fetchedAt = Date.now();
  const items: any[] = [];

  for (const [, loc] of locationMap) {
    if (loc.count < 3) continue; // Filter noise

    const country = loc.name.split(',').pop()?.trim() || "Unknown";
    const eventType = classifyGdeltEventType(loc.name);
    
    // Create aggregated cluster event
    const item = {
      id: `gdelt-${loc.lat.toFixed(2)}-${loc.lon.toFixed(2)}`, 
      lat: loc.lat,
      lon: loc.lon,
      type: eventType,
      subType: classifyGdeltSubType(loc.name, loc.count),
      actor1: "General Public",
      actor2: "N/A",
      fatalities: 0,
      country,
      location: loc.name,
      date: loc.date,
      source: "GDELT",
      notes: `${loc.count} clustered reports. Worst Tone: ${loc.worstTone.toFixed(1)}`,
      reportCount: loc.count
    };

    items.push(item);
    insertUnrest.run({
      id: item.id,
      payload: JSON.stringify(item),
      source_ts: new Date(item.date).getTime(),
      fetched_at: fetchedAt
    });
  }

  console.log(`[CivilUnrest] Clustered ${features.length} mentions into ${items.length} confirmed unrest events.`);

  await setLiveSnapshot(
    'civil_unrest',
    {
      source: 'gdelt',
      fetchedAt: new Date().toISOString(),
      items,
      totalCount: items.length
    },
    86400 
  );
}

registerSeeder({
  name: 'civilUnrest',
  cron: '*/15 * * * *', 
  fn: seedCivilUnrest
});
