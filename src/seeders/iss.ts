import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';

const WTIA_API_URL = "https://api.wheretheiss.at/v1/satellites/25544";
const POLLING_INTERVAL_MS = 5000; // Limit is ~1req/sec, so 5s is very safe

async function fetchISSData() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        
        const response = await fetch(WTIA_API_URL, {
            signal: controller.signal,
            headers: { "User-Agent": "WorldWideView/1.0" }
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[ISS] WTIA returned status ${response.status}`);
            return;
        }

        const data = await response.json();
        
        // Format ISS payload standard to the stream
        const stateObj = {
            id: data.id,
            name: "International Space Station",
            latitude: data.latitude,
            longitude: data.longitude,
            altitude: data.altitude, // in km
            velocity: data.velocity, // km/h
            visibility: data.visibility,
            footprint: data.footprint,
            timestamp: data.timestamp,
            daynum: data.daynum,
            solar_lat: data.solar_lat,
            solar_lon: data.solar_lon,
            units: "kilometers"
        };
        
        const redisPayload: Record<string, any> = {
            "25544": stateObj
        };

        // Cache for 60 seconds
        await setLiveSnapshot('iss', redisPayload, 60);

    } catch (e: any) {
        if (e.name === 'AbortError') {
            console.error('[ISS] Polling timeout');
        } else {
            console.error('[ISS] Polling error:', e.message);
        }
    }
}

let pollInterval: NodeJS.Timeout | null = null;

export function startISSSeeder() {
    console.log('[ISS] Starting ISS telemetry seeder...');
    
    // Initial fetch
    fetchISSData();
    
    // Loop
    pollInterval = setInterval(fetchISSData, POLLING_INTERVAL_MS);
}

registerSeeder({
    name: "iss",
    init: startISSSeeder
});
