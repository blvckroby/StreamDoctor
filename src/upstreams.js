import { assertSafeUrl } from './security.js';

function allowPrivate() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_PRIVATE_NETWORKS || '').toLowerCase());
}

export function manifestToBase(manifestUrl) {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json\/?$/i, '');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function resourceUrlFromManifest(manifestUrl, type, id) {
  const url = new URL(manifestUrl);
  const encodedType = encodeURIComponent(type);
  const encodedId = encodeURIComponent(id).replace(/%3A/gi, ':');
  url.pathname = url.pathname.replace(/\/manifest\.json\/?$/i, `/stream/${encodedType}/${encodedId}.json`);
  url.hash = '';
  // Keep query parameters: some configured addons carry auth/config in the query string.
  return url.href;
}

export async function fetchJsonDetailed(url, timeoutMs = 5000) {
  await assertSafeUrl(url, { allowPrivate: allowPrivate() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'StreamDoctor/0.2.2' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { data: await response.json(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, timeoutMs = 5000) {
  const result = await fetchJsonDetailed(url, timeoutMs);
  return result.data;
}

export async function validateManifest(manifestUrl) {
  const { data: manifest, finalUrl } = await fetchJsonDetailed(manifestUrl, 7000);
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest JSON');
  if (!manifest.id || !manifest.name || !Array.isArray(manifest.resources)) {
    throw new Error('Not a valid Stremio addon manifest');
  }
  const hasStream = manifest.resources.some((resource) =>
    resource === 'stream' || (resource && typeof resource === 'object' && resource.name === 'stream')
  );
  if (!hasStream) throw new Error('This addon does not expose the stream resource');
  return {
    manifest,
    // Use the resolved manifest URL. This fixes addons installed through redirects/aliases.
    manifestUrl: finalUrl,
    baseUrl: manifestToBase(finalUrl)
  };
}

export async function getStreamsFromUpstream(upstream, type, id, timeoutMs = 15000) {
  const manifestUrl = upstream.resolvedManifestUrl || upstream.manifestUrl;
  const url = resourceUrlFromManifest(manifestUrl, type, id);
  const started = Date.now();
  try {
    const payload = await fetchJson(url, timeoutMs);
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    return { ok: true, streams, error: null, latencyMs: Date.now() - started, requestUrl: url };
  } catch (error) {
    return { ok: false, streams: [], error: String(error?.message || error), latencyMs: Date.now() - started, requestUrl: url };
  }
}
