/**
 * Radio Garden — global radio-station places seeder.
 *
 * Pulls the full place index from Radio Garden's unofficial public API
 * (https://radio.garden/api/ara/content/places) and writes the entries
 * to Redis under `data:radio-garden:live`. The engine's generic
 * `/api/:id` route then surfaces this as `/api/radio-garden`.
 *
 * Each place has a stable id, a name, a country, a coordinate, and a
 * station count. Per-place channel listings and stream URLs are fetched
 * lazily by the WWV plugin's server-side proxy (Radio Garden's audio
 * stream endpoint 302-redirects to third-party hosts whose CORS policy
 * varies, so it's cleaner to resolve them server-side anyway).
 *
 * Interval is set high (24h) because the place list barely changes day
 * to day. Stations come and go inside a place; the place itself rarely
 * does.
 */

const ENDPOINT = "https://radio.garden/api/ara/content/places";
const USER_AGENT = "wwv-seeder-radio-garden/0.1 (+https://github.com/silvertakana/worldwideview)";

export default {
    name: "radio-garden",
    interval: 24 * 60 * 60 * 1000, // 24h

    async fetch() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
            const res = await fetch(ENDPOINT, {
                headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`Radio Garden /places returned ${res.status}`);
            }
            const body = await res.json();
            // Response shape: { apiVersion, version, data: { list: [ { id, title, geo: [lng, lat], country, size, url } ] } }
            const list = body?.data?.list;
            if (!Array.isArray(list)) {
                console.warn("[radio-garden] unexpected response shape — no data.list array");
                return [];
            }

            const items = [];
            for (const p of list) {
                const id = typeof p?.id === "string" ? p.id : null;
                const geo = Array.isArray(p?.geo) && p.geo.length >= 2 ? p.geo : null;
                if (!id || !geo) continue;

                const [lng, lat] = geo;
                if (typeof lng !== "number" || typeof lat !== "number") continue;
                if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

                items.push({
                    id,
                    name: typeof p.title === "string" ? p.title : id,
                    country: typeof p.country === "string" ? p.country : null,
                    lat,
                    lon: lng,
                    station_count: typeof p.size === "number" ? p.size : 0,
                    url: typeof p.url === "string" ? p.url : null,
                });
            }

            console.log(`[radio-garden] fetched ${items.length} places`);
            return items;
        } finally {
            clearTimeout(timeout);
        }
    },
};
