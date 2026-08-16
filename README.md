# WorldWideView Data Engine — Community Edition

The backend data engine powering [WorldWideView](https://worldwideview.dev), an open-source real-time geospatial intelligence platform.

This engine polls public geospatial APIs, caches the results in Redis, and streams them to the frontend via WebSocket.

> **Note:** The WorldWideView production environment uses an extended version of this engine with additional proprietary data sources (aviation tracking, maritime tracking, etc.).

## Included Seeders

| Seeder | Data Source | Update Frequency |
|---|---|---|
| ISS | [WhereTheISS.at](https://wheretheiss.at) | Every 5 seconds |
| Earthquakes | [USGS GeoJSON Feed](https://earthquake.usgs.gov) | Every hour |
| Wildfires | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) | Every 15 minutes |
| Sanctions | [OFAC US Treasury](https://sanctionslistservice.ofac.treas.gov) | Every hour |
| Civil Unrest | [GDELT Project](https://api.gdeltproject.org) | Every 15 minutes |
| Conflict Events | Mock data (placeholder) | Daily |
| GPS Jamming | Mock data (placeholder) | Daily |
| Cyber Attacks | [AlienVault OTX](https://otx.alienvault.com) (optional API key) | Every 2 hours |
| Satellites | [CelesTrak NORAD TLEs](https://celestrak.org) | TLEs hourly, positions every 15s |

## Quick Start

```bash
# Prerequisites: Node.js 20+, Redis running on localhost:6379
pnpm install
cp .env.local.example .env.local   # edit if needed
pnpm dev
```

The engine starts at `http://localhost:5000` (the `PORT` default; the ecosystem dev stack maps it to a host port via `ENGINE_PORT`, which also defaults to `5000`):
- `GET /health` — Engine status and seeder health
- `GET /manifest` — List of available seeders
- `WS /stream` — WebSocket endpoint for real-time data

## Authoring a Seeder

A seeder is a self-contained package the engine **auto-discovers** at startup.
You do not register it manually — the loader (`src/seeder-loader.ts`) scans
`SEEDERS_DIR` for any folder containing `dist/index.mjs` and imports its
**default export**. The seeder's canonical `id` is its self-declared `name`
field, so that name is what the frontend subscribes to. The folder name is
organisational only and is used as a fallback if the seeder exports no `name`.

### The module shape

The default export is an object with a `name` plus **one** of these shapes:

| Shape | You provide | How data gets published |
|---|---|---|
| `interval` (ms) + `fetch(ctx)` | `fetch` **returns** the array | The scheduler wraps your return value into `{ source, fetchedAt, items, totalCount }`, stores it, and broadcasts it. You publish nothing yourself. |
| `cron` (cron string) + `fn(ctx)` | `fn` publishes itself | Import and call `setLiveSnapshot` from `@worldwideview/seeder-sdk`. The scheduler does **not** wrap your return value. |
| `init(ctx)` (no cron/interval) | a persistent listener | For push sources (e.g. an upstream WebSocket). Publish via the SDK as data arrives. |

### The `ctx` object — read this before you write a line

`ctx` is **only `{ redis }`**. There is no `ctx.setLiveSnapshot`, no
`ctx.db`, no helpers. This is enforced by the `SeederContext` type in
`src/seeder-loader.ts`, so reaching for a method that isn't there is a
**compile error**, not a silent runtime failure. Everything you need to
fetch, persist, and publish lives in `@worldwideview/seeder-sdk`.

### Preferred: `interval` + `fetch` (self-contained, no SDK needed)

```ts
// dist/index.mjs — just return the array; the scheduler does the rest.
export default {
  name: "volcanoes",
  interval: 60_000,
  fetch: async () => {
    const items = await loadVolcanoes();
    return items; // -> stored + broadcast automatically
  },
};
```

### Dominant idiom: `cron` + `fn` (publish via the SDK)

```ts
import { db, setLiveSnapshot, fetchWithTimeout } from "@worldwideview/seeder-sdk";

async function seedVolcanoes() {
  const items = await fetchWithTimeout("https://example.org/volcanoes");
  // optional history: db.prepare("INSERT OR IGNORE INTO ...").run(...)
  await setLiveSnapshot("volcanoes", {
    source: "volcanoes",
    fetchedAt: new Date().toISOString(),
    items,
    totalCount: items.length,
  }, 3600);
}

export default { name: "volcanoes", cron: "0 * * * *", fn: seedVolcanoes };
```

`db`, `setLiveSnapshot`, and the fetch helpers all come from
`@worldwideview/seeder-sdk` — never from bare globals and never from `ctx`.
See `local-seeders/community/` for runnable examples and a copyable template.

## Docker

```bash
docker compose up -d
```

Runs the engine + Redis. Data persists in Docker volumes.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `PORT` | No | `5000` | Server port (the ecosystem dev stack overrides the host mapping via `ENGINE_PORT`, default `5000`) |
| `OTX_API_KEY` | No | — | AlienVault OTX key for the Cyber Attacks **seeder** (free tier available) — not read by the engine core |
| `DATABASE_URL` | No | — | Postgres URL for seeders that sync history (optional) — consumed by individual seeders, not the engine |

## Contributing

1. Fork this repo
2. Create a branch: `git checkout -b feat/my-seeder`
3. Add your seeder to the community seeders repo (`local-seeders/community/`); the engine auto-discovers it from the root `seeders/` directory at runtime — there is no `src/seeders/`
4. Add a corresponding route to `src/routes/` (if needed)
5. Test locally with `pnpm dev`
6. Open a PR

## License

MIT
