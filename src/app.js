import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './store.js';
import { validateManifest, getStreamsFromUpstream } from './upstreams.js';
import { classifyStream, dedupeStreams, decorateStream, fairRankDiagnosed, mapWithConcurrency, probeUrl, roundRobinBySource } from './doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configurePath = path.resolve(__dirname, '../public/configure.html');
const indexPath = path.resolve(__dirname, '../public/index.html');

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function createManifest(configured = false, p2p = false, logoUrl = '') {
  return {
    id: 'com.streamdoctor.addon',
    version: '0.2.4',
    name: 'StreamDoctor',
    description: 'Traffic-light stream diagnostics with adaptive probing, language detection and quality-first ordering.',
    ...(logoUrl ? { logo: logoUrl } : {}),
    resources: [{ name: 'stream', types: ['movie', 'series', 'tv', 'channel'] }],
    types: ['movie', 'series', 'tv', 'channel'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !configured,
      p2p
    }
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, payload) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

async function readBody(req, maxBytes = 65536) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type === 'application/json') return JSON.parse(raw);
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

function cleanPublicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader || 'http';
  return `${proto}://${req.headers.host}`.replace(/\/$/, '');
}

function parseRoute(pathname) {
  let match = pathname.match(/^\/([^/]+)\/manifest\.json$/);
  if (match) return { kind: 'configuredManifest', configId: decodeURIComponent(match[1]) };
  match = pathname.match(/^\/([^/]+)\/debug\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (match) {
    return {
      kind: 'debugStream',
      configId: decodeURIComponent(match[1]),
      type: decodeURIComponent(match[2]),
      id: decodeURIComponent(match[3])
    };
  }
  match = pathname.match(/^\/([^/]+)\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (match) {
    return {
      kind: 'stream',
      configId: decodeURIComponent(match[1]),
      type: decodeURIComponent(match[2]),
      id: decodeURIComponent(match[3])
    };
  }
  return null;
}

export async function createRequestListener(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve(__dirname, '../data');
  const store = options.store || new ConfigStore(dataDir);
  await store.init();
  const configureHtml = await fs.readFile(configurePath, 'utf8');
  const indexHtml = await fs.readFile(indexPath, 'utf8');
  const logoPng = await fs.readFile(path.resolve(__dirname, '../public/logo.png')).catch(() => null);

  return async function handler(req, res) {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true, name: 'StreamDoctor', version: '0.2.4' });
      }
      if (req.method === 'GET' && pathname === '/logo.png' && logoPng) {
        setCors(res);
        res.statusCode = 200;
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'public, max-age=86400');
        return res.end(logoPng);
      }
      if (req.method === 'GET' && pathname === '/manifest.json') {
        const publicUrl = cleanPublicUrl(req);
        return sendJson(res, 200, createManifest(false, false, `${publicUrl}/logo.png`));
      }
      if (req.method === 'GET' && pathname === '/') {
        return sendHtml(res, 200, indexHtml);
      }
      if (req.method === 'GET' && (pathname === '/configure' || /^\/[^/]+\/configure$/.test(pathname))) {
        return sendHtml(res, 200, configureHtml);
      }
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readBody(req);
        const lines = String(body.upstreams || '')
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean);
        const unique = [...new Set(lines)].slice(0, 12);
        if (!unique.length) return sendJson(res, 400, { error: 'Add at least one upstream manifest URL.' });

        const checked = await Promise.all(unique.map(async (manifestUrl) => {
          try {
            const { manifest, baseUrl, manifestUrl: resolvedManifestUrl } = await validateManifest(manifestUrl);
            return { ok: true, manifestUrl, resolvedManifestUrl, baseUrl, name: manifest.name, id: manifest.id, p2p: Boolean(manifest.behaviorHints?.p2p) };
          } catch (error) {
            return { ok: false, manifestUrl, error: String(error?.message || error) };
          }
        }));
        const valid = checked.filter((x) => x.ok).map(({ ok, ...x }) => x);
        const invalid = checked.filter((x) => !x.ok);
        if (!valid.length) return sendJson(res, 400, { error: 'No valid stream addons found.', invalid });

        const config = {
          upstreams: valid,
          hideDead: body.hideDead === true || body.hideDead === 'true' || body.hideDead === 'on',
          probeTimeoutMs: clampNumber(body.probeTimeoutMs, 1000, 10000, 3500),
          upstreamTimeoutMs: clampNumber(body.upstreamTimeoutMs, 5000, 30000, 15000),
          maxStreams: clampNumber(body.maxStreams, 5, 100, 40),
          hasP2p: valid.some((item) => item.p2p)
        };
        const id = await store.create(config);
        const publicUrl = cleanPublicUrl(req);
        const manifestUrl = `${publicUrl}/${id}/manifest.json`;
        return sendJson(res, 200, {
          id,
          manifestUrl,
          installUrl: manifestUrl.replace(/^https?:\/\//, 'stremio://'),
          valid,
          invalid
        });
      }

      const route = parseRoute(pathname);
      if (req.method === 'GET' && route?.kind === 'configuredManifest') {
        const config = await store.get(route.configId);
        if (!config) return sendJson(res, 404, { error: 'Unknown StreamDoctor configuration.' });
        const publicUrl = cleanPublicUrl(req);
        return sendJson(res, 200, createManifest(true, Boolean(config.hasP2p), `${publicUrl}/logo.png`));
      }

      if (req.method === 'GET' && route?.kind === 'debugStream') {
        const config = await store.get(route.configId);
        if (!config) return sendJson(res, 404, { error: 'Unknown StreamDoctor configuration.' });
        const results = await Promise.all(config.upstreams.map(async (upstream) => {
          const result = await getStreamsFromUpstream(upstream, route.type, route.id, config.upstreamTimeoutMs || 15000);
          return {
            name: upstream.name || upstream.id || 'Upstream',
            id: upstream.id || null,
            ok: result.ok,
            streams: result.streams.length,
            latencyMs: result.latencyMs,
            error: result.error
          };
        }));
        return sendJson(res, 200, { type: route.type, id: route.id, upstreamTimeoutMs: config.upstreamTimeoutMs || 15000, providers: results });
      }

      if (req.method === 'GET' && route?.kind === 'stream') {
        const config = await store.get(route.configId);
        if (!config) return sendJson(res, 404, { streams: [] });
        const supported = ['movie', 'series', 'tv', 'channel'];
        if (!supported.includes(route.type)) return sendJson(res, 200, { streams: [] });

        const upstreamResults = await Promise.all(config.upstreams.map(async (upstream) => {
          const result = await getStreamsFromUpstream(upstream, route.type, route.id, config.upstreamTimeoutMs || 15000);
          return { upstream, ...result };
        }));

        let items = [];
        for (const result of upstreamResults) {
          for (const stream of result.streams) {
            if (!stream || typeof stream !== 'object') continue;
            items.push({
              stream,
              sourceName: result.upstream.name || result.upstream.id || 'Upstream',
              sourceKey: result.upstream.id || result.upstream.resolvedManifestUrl || result.upstream.manifestUrl
            });
          }
        }
        items = dedupeStreams(items);
        // Do not let the first noisy addon consume every slot. Probe a fair sample from each source.
        const maxStreams = config.maxStreams || 40;
        const probeBudget = Math.min(240, Math.max(80, maxStreams * 3));
        items = roundRobinBySource(items, probeBudget);

        const concurrency = clampNumber(process.env.PROBE_CONCURRENCY, 1, 12, 4);
        const diagnosed = await mapWithConcurrency(items, concurrency, async (item) => {
          if (!item.stream.url || !/^https?:\/\//i.test(item.stream.url)) {
            return { ...item, probe: null, sortScore: 2 };
          }
          const probe = await probeUrl(item.stream.url, item.stream.behaviorHints || {}, {
            timeoutMs: config.probeTimeoutMs
          });
          const classification = classifyStream(item.stream, item.sourceName, probe);
          return { ...item, probe, classification, sortScore: classification.score + Math.min(probe.latencyMs || 0, 5000) / 100000 };
        });

        const visible = diagnosed.filter((item) => !(config.hideDead && item.probe?.state === 'dead'));
        // Status still wins (green → yellow → unprobed → orange → red), but providers are interleaved
        // inside each status bucket so EasyStreams/other later addons cannot be starved by ToastFlix.
        const ranked = fairRankDiagnosed(visible, maxStreams);
        const output = ranked.map((item) => decorateStream(item.stream, item.sourceName, item.probe));

        res.setHeader('Cache-Control', 'public, max-age=20');
        return sendJson(res, 200, { streams: output });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: 'Internal StreamDoctor error.', detail: String(error?.message || error) });
    }
  };
}
