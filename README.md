# StreamDoctor MVP v0.2.4

StreamDoctor is a **middleware addon for Stremio/Nuvio**. It queries the stream addons you configure, merges their results, checks direct HTTP streams, removes duplicates, enriches useful metadata, and returns a compact traffic-light list.

## v0.2.4 highlights

- Multiple upstream Stremio addon manifests
- Stream aggregation for `movie`, `series`, `tv`, and `channel`
- Direct HTTP/HLS/DASH reachability probe
- Traffic-light diagnosis: green / yellow / orange / red
- ToastFlix-aware Direct vs Sidecar/pipeline heuristic
- **Spoken-language detection from HLS audio tracks** when declared
- Language fallback from upstream labels such as `ITA`, `ENG`, `JPN`, `Dual Audio`
- Subtitle-only labels such as `SUB ITA` are not intentionally treated as Italian audio
- **Quality detection and sorting** from HLS resolution or upstream labels
- Ordering: status first, then resolution (`4K → 1440p → 1080p → 720p → SD → unknown`)
- Fair interleaving between providers inside the same status/quality tier
- HLS advertised bitrate when available
- Content size when directly known; estimated HLS size only when enough playlist data is available
- Latency measurement
- Uses upstream `behaviorHints.proxyHeaders.request` while probing
- Deduplication and optional hiding of confirmed dead URLs
- Pass-through for torrents / `infoHash` and other non-HTTP stream types
- Basic SSRF protection for public deployments
- Provider debug endpoint

## Minimal stream labels

The first line is intentionally compact:

```text
🟢 • 4K • ITA/ENG • EasyStreams
HLS • 14 Mbps • 132ms

🟡 • 1080p • ITA • ToastFlix
Sidecar • HLS • 410ms

🟠 • 1080p • ENG • Provider
HTTP 403 • HLS • 220ms

🔴 • 720p • Provider
DEAD 410 • HLS • 95ms
```

`READY`, `Source:` and repeated status text are deliberately omitted from healthy results.

## Sorting

StreamDoctor sorts in this order:

1. 🟢 ready
2. 🟡 extra pipeline / Sidecar risk
3. ⚪ not probed
4. 🟠 error / timeout / temporary HTTP failure
5. 🔴 confirmed dead

Inside **each status**, higher definition wins:

`8K → 4K → 1440p → 1080p → 720p → 576p → 480p → unknown`

Providers are still interleaved inside the same quality tier so a noisy addon cannot consume every visible slot.

## Language detection

StreamDoctor does **not** perform speech recognition or download the full audio track.

It uses, in order:

1. HLS `#EXT-X-MEDIA` audio-track `LANGUAGE` / `NAME` metadata.
2. Explicit upstream stream labels such as `ITA`, `ENG`, `JPN`, `Italian`, `English`, `Dual Audio`.

If the stream does not expose trustworthy language metadata, StreamDoctor simply omits the language instead of guessing.

## Run locally

Requires Node.js 20+.

```bash
node src/index.js
```

Then open:

```text
http://127.0.0.1:7000/configure
```

For localhost/LAN upstream addons on Windows PowerShell:

```powershell
$env:ALLOW_PRIVATE_NETWORKS="true"
node src/index.js
```

Do **not** enable private-network probing on a public deployment unless you understand the SSRF risk.

## Main environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `7000` | HTTP port |
| `PUBLIC_URL` | inferred | Public base URL for generated manifests |
| `DATA_DIR` | `./data` | Opaque configurations |
| `PROBE_TIMEOUT_MS` | `3500` | Individual stream probe timeout |
| `PROBE_CONCURRENCY` | `6` | Simultaneous stream probes |
| `CACHE_TTL_MS` | `45000` | Probe cache |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Permit localhost/private IPs |

The web configurator also stores a separate upstream-addon search timeout (default 15s), so slower aggregators such as EasyStreams are not discarded just because individual stream probes are intentionally fast.

## Provider debug endpoint

If an upstream works directly but does not appear through StreamDoctor:

```text
/<config-id>/debug/stream/<type>/<id>.json
```

Example:

```text
http://127.0.0.1:7000/<config-id>/debug/stream/series/tt1234567:1:1.json
```

It reports whether each addon answered, how many streams it returned, latency, and request errors.

## Current limits

- Torrent availability is not actively probed.
- DASH language/resolution parsing is not implemented yet.
- HLS metadata depends on what the provider actually declares.
- MP4 files usually do not expose spoken-language metadata in the small HTTP probe; StreamDoctor will not guess it unless the upstream labels it.
- StreamDoctor diagnoses before selection; it cannot switch source transparently after playback has already started.

## Docker

```bash
docker build -t streamdoctor .
docker run --rm -p 7000:7000 -e ALLOW_PRIVATE_NETWORKS=true streamdoctor
```


## Adaptive timeout handling

StreamDoctor first runs a fast probe. A timeout is retried once with a longer window, probes are limited per host, and timeout results are cached only briefly. A timeout therefore means the diagnostic probe was slow, not that the original stream is confirmed dead. Known Sidecar/pipeline streams remain yellow on timeout.


## Web landing page

Version 0.2.4 adds a branded landing page at `/` and keeps the addon configurator at `/configure`. The landing page uses the bundled StreamDoctor logo and has no external frontend dependencies.

## Production persistence

Configurations are stored in `DATA_DIR/configs.json`. On a public host, mount persistent storage at the configured `DATA_DIR` (the Docker image defaults to `/app/data`). Without persistent storage, generated configuration IDs can disappear after a restart or redeploy.
