/**
 * Aviation seeder — polls OpenSky Network for global commercial aircraft.
 *
 * Public unauthenticated requests are heavily rate-limited (~100/day from a
 * given IP). Set OPENSKY_USER and OPENSKY_PASS to use a registered account
 * for far higher quotas (~4000/day).
 *
 * Output is a flat array shaped to match what `@worldwideview/wwv-plugin-aviation`
 * expects (icao24, callsign, origin_country, lat, lon, alt, spd, hdg, ...).
 */

import { setLiveSnapshot } from '../redis';
import { registerSeeder } from '../scheduler';

const OPENSKY_URL = 'https://opensky-network.org/api/states/all';

// OpenSky's free public API rate-limits anonymous requests at ~100/day per IP.
// 24h / 100 = ~14.4 min/req, so we use 16 min unauthenticated to leave margin
// for restarts / retries. Registered accounts get ~4000/day (~21s/req minimum)
// so when creds are set we drop to 60s for near-real-time updates.
const POLL_INTERVAL_ANONYMOUS_MS = 16 * 60_000;
const POLL_INTERVAL_AUTH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 25_000;

function buildAuthHeader(): string | undefined {
    const user = process.env.OPENSKY_USER;
    const pass = process.env.OPENSKY_PASS;
    if (!user || !pass) return undefined;
    const token = Buffer.from(`${user}:${pass}`).toString('base64');
    return `Basic ${token}`;
}

function getPollInterval(): number {
    return buildAuthHeader() ? POLL_INTERVAL_AUTH_MS : POLL_INTERVAL_ANONYMOUS_MS;
}

interface AviationSnapshot {
    icao24: string;
    callsign: string | null;
    origin_country: string;
    lon: number;
    lat: number;
    alt: number | null;
    on_ground: boolean;
    spd: number | null;
    hdg: number | null;
    vertical_rate: number | null;
    squawk: string | null;
    ts: number;
    last_contact: number;
}

function stateRowToObject(row: any[]): AviationSnapshot | null {
    const lon = row[5];
    const lat = row[6];
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    return {
        icao24: row[0],
        callsign: typeof row[1] === 'string' ? row[1].trim() || null : null,
        origin_country: row[2] ?? '',
        lon,
        lat,
        alt: row[7] ?? row[13] ?? null, // baro_altitude, fall back to geo_altitude
        on_ground: Boolean(row[8]),
        spd: row[9] ?? null,
        hdg: row[10] ?? null,
        vertical_rate: row[11] ?? null,
        squawk: row[14] ?? null,
        ts: row[3] ?? row[4] ?? 0,
        last_contact: row[4] ?? 0,
    };
}

async function pollAviation(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = {
            'User-Agent': 'WorldWideView-DataEngine/1.0',
        };
        const auth = buildAuthHeader();
        if (auth) headers['Authorization'] = auth;

        const res = await fetch(OPENSKY_URL, { headers, signal: controller.signal });
        clearTimeout(timeout);

        if (res.status === 429) {
            console.warn('[Aviation] OpenSky rate-limited (429) — try setting OPENSKY_USER / OPENSKY_PASS for higher quota');
            return;
        }
        if (!res.ok) {
            console.error(`[Aviation] OpenSky returned ${res.status}`);
            return;
        }

        const data = (await res.json()) as { time: number; states: any[][] | null };
        const states = Array.isArray(data?.states) ? data.states : [];

        const aircraft: AviationSnapshot[] = [];
        for (const row of states) {
            const obj = stateRowToObject(row);
            if (obj) aircraft.push(obj);
        }

        // Cache TTL: a bit longer than the poll interval so a single failed
        // poll doesn't blank out the snapshot before the next one lands.
        const ttlSec = Math.ceil((getPollInterval() / 1000) * 2);
        await setLiveSnapshot('aviation', aircraft, ttlSec);
        console.log(`[Aviation] ${aircraft.length} aircraft snapshotted at ${data.time}`);
    } catch (e: any) {
        clearTimeout(timeout);
        if (e?.name === 'AbortError') {
            console.error('[Aviation] OpenSky request timed out');
        } else {
            console.error('[Aviation] poll error:', e?.message ?? e);
        }
    }
}

let pollHandle: NodeJS.Timeout | null = null;

export function startAviationSeeder(): void {
    const interval = getPollInterval();
    const mode = buildAuthHeader() ? 'authenticated' : 'anonymous';
    console.log(`[Aviation] Starting OpenSky seeder (${mode}, polling every ${Math.round(interval / 1000)}s)`);
    pollAviation();
    pollHandle = setInterval(pollAviation, interval);
}

registerSeeder({
    name: 'aviation',
    init: startAviationSeeder,
});
