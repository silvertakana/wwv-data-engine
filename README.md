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

The engine starts at `http://localhost:5000`:
- `GET /health` — Engine status and seeder health
- `GET /manifest` — List of available seeders
- `WS /stream` — WebSocket endpoint for real-time data

## Adding a New Seeder

1. Create a new `.ts` file in `src/seeders/` (e.g., `volcanoes.ts`)
2. Implement your polling/fetching logic
3. Call `registerSeeder({ name: "volcanoes", cron: "0 * * * *", fn: seedVolcanoes })`
4. That's it — auto-discovery picks it up automatically

See existing seeders for examples. Every seeder follows the same pattern:
- Fetch data from a public API
- Store in SQLite history via `db.prepare()`
- Publish to Redis live cache via `setLiveSnapshot()`

## Docker

```bash
docker compose up -d
```

Runs the engine + Redis. Data persists in Docker volumes.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `PORT` | No | `5000` | Server port |
| `OTX_API_KEY` | No | — | AlienVault OTX key for cyber attacks (free tier available) |
| `DATABASE_URL` | No | — | Supabase/Postgres URL for historical sync (optional) |

## Contributing

1. Fork this repo
2. Create a branch: `git checkout -b feat/my-seeder`
3. Add your seeder to `src/seeders/`
4. Add a corresponding route to `src/routes/` (if needed)
5. Test locally with `pnpm dev`
6. Open a PR

## License

MIT
