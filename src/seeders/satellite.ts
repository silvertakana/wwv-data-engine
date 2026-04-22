// Dynamic import required by cjs/esm interop
import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';

const BASE_URL = "https://celestrak.org/NORAD/elements/gp.php";

export const DEFAULT_GROUPS = [
    "stations",       // ISS, Tiangong, etc.
    "visual",         // Brightest 100 satellites
    "weather",        // Weather satellites
    "gps-ops",        // GPS constellation
    "resource",       // Earth observation / reconnaissance
    "military",       // Military reconnaissance
] as const;

export interface CelesTrakGP {
    OBJECT_NAME: string;
    TLE_LINE1: string;
    TLE_LINE2: string;
    NORAD_CAT_ID: number;
    COUNTRY_CODE?: string;
    OBJECT_TYPE?: string;
    PERIOD?: number;
}

// In-memory global TLE cache for computing on-the-fly positions
export const globalsTLECache = new Map<string, CelesTrakGP[]>();

async function fetchTLEGroup(group: string): Promise<CelesTrakGP[]> {
    const url = `${BASE_URL}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "WorldWideView" } });

    if (!res.ok) {
        console.error(`[SatelliteSeeder] CelesTrak returned ${res.status} for group=${group}`);
        return [];
    }

    const text = await res.text();
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const data: CelesTrakGP[] = [];
    
    for (let i = 0; i < lines.length - 2; i += 3) {
        data.push({
            OBJECT_NAME: lines[i],
            TLE_LINE1: lines[i + 1],
            TLE_LINE2: lines[i + 2],
            NORAD_CAT_ID: parseInt(lines[i + 1].substring(2, 7).trim(), 10),
        } as CelesTrakGP);
    }
    return data;
}

async function refreshAllTLEs() {
    console.log('[SatelliteSeeder] Refreshing TLEs from Celestrak...');
    for (const group of DEFAULT_GROUPS) {
        try {
            const records = await fetchTLEGroup(group);
            if (records.length > 0) {
                globalsTLECache.set(group, records);
            }
        } catch (err: any) {
             console.error(`[SatelliteSeeder] Error fetching ${group}:`, err.message);
        }
    }
}

// Exported standard propagation function
export function propagateAll(records: CelesTrakGP[], time: Date, group: string): any[] {
    const satellite = require('satellite.js');
    const gmst = satellite.gstime(time);
    const results: any[] = [];

    for (const rec of records) {
        try {
            const satrec = satellite.twoline2satrec(rec.TLE_LINE1, rec.TLE_LINE2);
            const pv = satellite.propagate(satrec, time);
            
            if (!pv.position || typeof pv.position === "boolean" || !pv.velocity || typeof pv.velocity === "boolean") {
                continue;
            }

            const geo = satellite.eciToGeodetic(pv.position as any, gmst);
            const lat = satellite.degreesLat(geo.latitude);
            const lon = satellite.degreesLong(geo.longitude);
            const alt = geo.height; // km

            if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) continue;
            if (alt < 0 || alt > 100000) continue;

            const vel = pv.velocity as any;
            const speed = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2) * 1000;
            const heading = (Math.atan2(vel.x, vel.z) * (180 / Math.PI) + 360) % 360;

            results.push({
                noradId: rec.NORAD_CAT_ID,
                name: rec.OBJECT_NAME,
                latitude: lat,
                longitude: lon,
                altitude: alt,
                heading,
                speed,
                group,
                country: rec.COUNTRY_CODE,
                objectType: rec.OBJECT_TYPE,
                period: rec.PERIOD,
            });
        } catch {
            // Error in propagation, skip
        }
    }

    return results;
}

async function computeAndPublishPositions() {
    const now = new Date();
    const civilianObj: Record<string, any> = Object.create(null);
    const militaryObj: Record<string, any> = Object.create(null);
    let totalCivilian = 0;
    let totalMilitary = 0;

    for (const group of DEFAULT_GROUPS) {
        const records = globalsTLECache.get(group);
        if (!records) continue;

        const isMilitary = group === "military" || group === "resource";
        const positions = propagateAll(records, now, group);
        for (const p of positions) {
             if (isMilitary) {
                 militaryObj[p.noradId] = p;
                 totalMilitary++;
             } else {
                 civilianObj[p.noradId] = p;
                 totalCivilian++;
             }
        }
    }

    if (totalCivilian > 0) {
        await setLiveSnapshot('satellite', civilianObj, 60 * 60);
    }
    if (totalMilitary > 0) {
        await setLiveSnapshot('surveillance_satellites', militaryObj, 60 * 60);
    }
}

let syncParams = {
    tleFetchInterval: 1000 * 60 * 60, // 1 hour
    publishInterval: 1000 * 15,       // 15 seconds
    tleIntervalId: null as any,
    publishIntervalId: null as any
};

export function startSatelliteSeeder() {
    console.log('[SatelliteSeeder] Starting satellite TLE seeder.');
    
    refreshAllTLEs().then(() => {
        computeAndPublishPositions();
        syncParams.publishIntervalId = setInterval(computeAndPublishPositions, syncParams.publishInterval);
    });
    
    syncParams.tleIntervalId = setInterval(refreshAllTLEs, syncParams.tleFetchInterval);
}

registerSeeder({
    name: "satellite",
    init: startSatelliteSeeder
});
