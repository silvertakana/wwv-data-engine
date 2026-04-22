import { db } from '../db';
import { setLiveSnapshot } from '../redis';
import { fetchWithTimeout, withRetry } from '../seed-utils';
import { registerSeeder } from '../scheduler';

interface FIRMSRecord {
  latitude: number;
  longitude: number;
  bright_ti4: number;
  scan: number;
  track: number;
  acq_date: string;
  acq_time: string;
  satellite: string;
  confidence: string;
  version: string;
  bright_ti5: number;
  frp: number;
  daynight: string;
}

function parseCSV(csv: string): FIRMSRecord[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const records: FIRMSRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    if (values.length < headers.length) continue;

    const record: Record<string, string | number> = {};
    headers.forEach((header, idx) => {
      record[header] = values[idx]?.trim() || "";
    });

    const lat = parseFloat(record["latitude"] as string);
    const lon = parseFloat(record["longitude"] as string);
    if (isNaN(lat) || isNaN(lon)) continue;

    records.push({
      latitude: lat,
      longitude: lon,
      bright_ti4: parseFloat(record["bright_ti4"] as string) || 0,
      scan: parseFloat(record["scan"] as string) || 0,
      track: parseFloat(record["track"] as string) || 0,
      acq_date: (record["acq_date"] as string) || "",
      acq_time: (record["acq_time"] as string) || "",
      satellite: (record["satellite"] as string) || "",
      confidence: (record["confidence"] as string) || "",
      version: (record["version"] as string) || "",
      bright_ti5: parseFloat(record["bright_ti5"] as string) || 0,
      frp: parseFloat(record["frp"] as string) || 0,
      daynight: (record["daynight"] as string) || "",
    });
  }
  return records;
}

const insertWildfire = db.prepare('INSERT OR IGNORE INTO wildfires (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)');

export async function seedWildfires() {
  console.log('[Wildfires] Polling NASA FIRMS...');

  // Use open CSV feed
  const url = `https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv`;

  const res = await withRetry(() => fetchWithTimeout(url));
  const csv = await res.text();
  const fires = parseCSV(csv);
  const fetchedAt = Date.now();

  if (fires.length === 0) {
    console.log('[Wildfires] No fires found or parsing failed.');
    return;
  }

  // Multi-Tier Clustering logic (Preserved from original implementation)
  const tiers = [
      { level: 1, size: 2.0 },   // Macro: ~220km
      { level: 2, size: 0.5 },   // Meso: ~55km
      { level: 3, size: 0.05 },  // Micro: ~5.5km
  ];

  const allClusteredFires: (FIRMSRecord & { tier: number, id: string })[] = [];

  for (const tier of tiers) {
      const clustered = new Map<string, FIRMSRecord & { tier: number, id: string }>();

      for (const fire of fires) {
          const gridId = `${Math.floor(fire.latitude / tier.size)}_${Math.floor(fire.longitude / tier.size)}`;
          const existing = clustered.get(gridId);
          if (existing) {
              existing.frp += fire.frp;
              if (fire.confidence === "high" || (fire.confidence === "nominal" && existing.confidence === "low")) {
                  existing.confidence = fire.confidence;
              }
          } else {
              // Creating a unique ID based on date, time, lat, lon to allow deduplication in SQLite
              const id = `firm_${fire.acq_date}_${fire.acq_time}_${Math.round(fire.latitude*1000)}_${Math.round(fire.longitude*1000)}_t${tier.level}`;
              clustered.set(gridId, { ...fire, tier: tier.level, id });
          }
      }
      allClusteredFires.push(...Array.from(clustered.values()));
  }

  // Save to SQLite History
  let insertedCount = 0;
  const insertMany = db.transaction((firesList) => {
    for (const f of firesList) {
      // Create a pseudo-timestamp from acq_date and acq_time: "2024-04-01" "1430"
      const timeStr = f.acq_time.toString().padStart(4, '0');
      const tsStr = `${f.acq_date}T${timeStr.substring(0,2)}:${timeStr.substring(2,4)}:00Z`;
      let sourceTs = 0;
      try {
        sourceTs = new Date(tsStr).getTime();
        if (isNaN(sourceTs)) sourceTs = fetchedAt;
      } catch (e) {
        sourceTs = fetchedAt;
      }

      const result = insertWildfire.run({
        id: f.id,
        payload: JSON.stringify(f),
        source_ts: sourceTs,
        fetched_at: fetchedAt
      });
      if (result.changes > 0) insertedCount++;
    }
  });

  insertMany(allClusteredFires);
  console.log(`[Wildfires] Parsed ${fires.length} raw fires -> Clustered ${allClusteredFires.length} points. Saved ${insertedCount} new to SQLite.`);

  // Save full clustered map to Redis
  await setLiveSnapshot('wildfires', {
    source: "wildfires",
    fetchedAt: new Date().toISOString(),
    items: allClusteredFires,
    totalCount: allClusteredFires.length
  }, 1800); // 30 mins TTL
}

// Register with scheduler
registerSeeder({
  name: "wildfires",
  cron: "*/15 * * * *", // Every 15 minutes
  fn: seedWildfires
});
