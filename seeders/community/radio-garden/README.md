# wwv-seeder-radio-garden

Pulls the full place index from [Radio Garden](https://radio.garden) (their
unofficial public API at `radio.garden/api/ara/content/places`) and exposes
it through the wwv-data-engine generic `/api/radio-garden` endpoint.

## What it produces

A list of *places* — cities and towns — each with:

| field           | type     | notes                                                   |
| --------------- | -------- | ------------------------------------------------------- |
| `id`            | string   | Radio Garden place id, used to look up its channels     |
| `name`          | string   | Display name (e.g. "Austin")                            |
| `country`       | string?  | Country name                                            |
| `lat`, `lon`    | number   | WGS84 coordinates                                       |
| `station_count` | number   | Number of stations broadcasting from this place         |
| `url`           | string?  | Radio Garden permalink                                  |

Per-place channel lists and audio stream URLs are intentionally **not**
fetched here. The list endpoint already exposes the count, and the
per-channel resolution involves a 302 redirect to third-party stream
hosts with varying CORS policy — that resolution belongs in the
consuming application's server-side proxy.

## Schedule

Refreshes every 24 hours. The place list barely changes day to day;
the churn lives at the channel level (which we don't seed).

## Endpoint

After the engine boots with this seeder mounted, the data is served at:

```
GET /api/radio-garden
→ { source, fetchedAt, items: [ ... ], totalCount }
```

## Source

Radio Garden's API is unofficial and undocumented; the schema we rely
on is based on the community-maintained OpenAPI spec at
https://jonasrmichel.github.io/radio-garden-openapi/. Be a good
neighbour — don't hammer the place list.
