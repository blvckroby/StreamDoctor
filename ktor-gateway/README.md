# Nuvio Smart Gateway (Ktor)

Independent Kotlin/Ktor service alongside the existing StreamDoctor Node.js addon.

## MVP features

- Stremio-compatible stream manifest and stream resource routes.
- Configure up to 12 upstream addon manifests through `POST /api/config`.
- Query configured upstreams concurrently using Kotlin coroutines.
- Short in-memory response cache (20 seconds) and URL-based deduplication.
- Per-upstream timeout and maximum result controls.
- Persistent configuration file under `DATA_DIR/configs.json`.
- HTTPS-only upstream manifests and basic public-address validation to reduce SSRF risk.

This gateway does not modify third-party addons or bypass provider authentication, IP restrictions, DRM, paywalls, or access controls. It can aggregate only addons that permit requests from the gateway and expose a compatible Stremio stream resource.

## Run locally

Requires JDK 21 and Gradle 8.14+.

From this directory:

```bash
gradle run
```

Default port: `7860`.

## Configure upstream addons

```bash
curl -X POST http://localhost:7860/api/config \
  -H "Content-Type: application/json" \
  -d '{"upstreams":["https://example.org/manifest.json"],"maxStreams":50,"upstreamTimeoutMs":12000}'
```

The response contains a configured `manifestUrl`. Add that URL to Nuvio only after testing the upstream addon permissions and compatibility.

## Routes

- `GET /health`
- `GET /manifest.json`
- `POST /api/config`
- `GET /{configId}/manifest.json`
- `GET /{configId}/stream/{type}/{id}.json`

## Northflank

Create a service from this repository and set the build context to `ktor-gateway` with Dockerfile path `Dockerfile` (or configure the root context and Dockerfile path `ktor-gateway/Dockerfile`, depending on the Northflank build mode).

Environment variables:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `7860` | HTTP port |
| `PUBLIC_URL` | inferred localhost URL | Public HTTPS base URL |
| `DATA_DIR` | `/app/data` | Persistent configuration directory |

Attach persistent storage at `/app/data`. Terminate public traffic over HTTPS at Northflank.

## Current limitations

- The existing StreamDoctor Node.js service remains unchanged; this Ktor service is a separate experimental implementation.
- No transparent interception of requests made directly by Nuvio to unrelated addons.
- Upstreams must allow requests from the gateway's server IP.
- The first version supports Stremio-compatible stream addons only. M3U and external catalog adapters will be added after the core aggregator is verified.
- Cache is in-memory and resets on restart.
- Do not use this as a generic open proxy. Keep it private or add authentication/rate limiting before exposing it publicly.
