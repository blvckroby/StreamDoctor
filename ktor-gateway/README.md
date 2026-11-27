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
- Admin token required to create configurations.

This gateway does not modify third-party addons or bypass provider authentication, IP restrictions, DRM, paywalls, or access controls. It can aggregate only addons that permit requests from the gateway and expose a compatible Stremio stream resource.

## Run locally

Requires JDK 21 and Gradle 8.14+.

From this directory:

```bash
gradle run
```

Default port: `7860`.

## Configure upstream addons

Set an admin token first:

```bash
export ADMIN_TOKEN="replace-with-a-long-random-secret"
```

Then configure permitted upstream manifests:

```bash
curl -X POST http://localhost:7860/api/config \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: replace-with-a-long-random-secret" \
  -d '{"upstreams":["https://example.org/manifest.json"],"maxStreams":50,"upstreamTimeoutMs":12000}'
```

The response contains a configured `manifestUrl`. Add that URL to Nuvio only after testing upstream permissions and compatibility.

## Routes

- `GET /health`
- `GET /manifest.json`
- `POST /api/config` (requires `X-Admin-Token`)
- `GET /{configId}/manifest.json`
- `GET /{configId}/stream/{type}/{id}.json`

## Northflank

Build this service with **build context set to `ktor-gateway`** and Dockerfile path `Dockerfile`. Do not use the repository root as the build context for this Dockerfile.

Environment variables:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `7860` | HTTP port |
| `PUBLIC_URL` | inferred localhost URL | Public HTTPS base URL |
| `DATA_DIR` | `/app/data` | Persistent configuration directory |
| `ADMIN_TOKEN` | unset | Required secret for configuring upstream addons |

Attach persistent storage at `/app/data`, set a long random `ADMIN_TOKEN`, and terminate public traffic over HTTPS at Northflank.

## Current limitations

- The existing StreamDoctor Node.js service remains unchanged; this Ktor service is a separate experimental implementation.
- No transparent interception of requests made directly by Nuvio to unrelated addons.
- Upstreams must allow requests from the gateway's server IP.
- Upstreams must serve the manifest directly over HTTPS; redirects are not followed in this MVP.
- The first version supports Stremio-compatible stream addons only. M3U and external catalog adapters will be added after the core aggregator is verified.
- Cache is in-memory and resets on restart.
- Do not use this as a generic open proxy. Keep it private and protect the configuration endpoint with `ADMIN_TOKEN`.
