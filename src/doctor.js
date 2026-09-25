import { assertSafeUrl } from './security.js';

const cache = new Map();
const hostSlots = new Map();

async function acquireHostSlot(host, limit = 2) {
  const key = String(host || 'unknown');
  let entry = hostSlots.get(key);
  if (!entry) {
    entry = { active: 0, queue: [] };
    hostSlots.set(key, entry);
  }
  if (entry.active >= limit) {
    await new Promise((resolve) => entry.queue.push(resolve));
  }
  entry.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.active = Math.max(0, entry.active - 1);
    const next = entry.queue.shift();
    if (next) next();
    if (entry.active === 0 && entry.queue.length === 0) hostSlots.delete(key);
  };
}


function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value === 'string' && value.length <= 4096) out[key] = value;
  }
  return out;
}

function inferFormat(url, contentType = '', sample = '') {
  const lower = String(url).toLowerCase();
  const ct = String(contentType).toLowerCase();
  if (sample.includes('#EXTM3U') || lower.includes('.m3u8') || ct.includes('mpegurl')) return 'HLS';
  if (lower.includes('.mpd') || ct.includes('dash+xml')) return 'DASH';
  if (lower.includes('.mp4') || ct.includes('video/mp4')) return 'MP4';
  if (ct.startsWith('video/')) return ct.replace('video/', '').toUpperCase();
  return 'HTTP';
}

function statusMeta(status) {
  if (status >= 200 && status < 400) return { state: 'healthy', icon: '🟢', label: 'READY', score: 0 };
  if (status === 404 || status === 410) return { state: 'dead', icon: '🔴', label: `DEAD ${status}`, score: 4 };
  if ([401, 403, 429].includes(status)) return { state: 'error', icon: '🟠', label: `HTTP ${status}`, score: 3 };
  if (status >= 500) return { state: 'error', icon: '🟠', label: `UPSTREAM ${status}`, score: 3 };
  return { state: 'error', icon: '🟠', label: `HTTP ${status}`, score: 3 };
}

async function readSmallSample(response, limit = 32768) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice = value.subarray(0, Math.max(0, limit - size));
      chunks.push(slice);
      size += slice.byteLength;
      if (size >= limit) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseHlsAttributes(raw = '') {
  const out = {};
  const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = regex.exec(raw))) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[match[1].toUpperCase()] = value;
  }
  return out;
}

function normalizeLanguageCode(raw) {
  const value = String(raw || '').trim().toLowerCase().replace('_', '-');
  if (!value) return null;
  const base = value.split('-')[0];
  const map = {
    it: 'ITA', ita: 'ITA', italian: 'ITA', italiano: 'ITA',
    en: 'ENG', eng: 'ENG', english: 'ENG', inglese: 'ENG',
    ja: 'JPN', jpn: 'JPN', jap: 'JPN', japanese: 'JPN', giapponese: 'JPN',
    es: 'SPA', spa: 'SPA', spanish: 'SPA', spagnolo: 'SPA',
    fr: 'FRA', fra: 'FRA', fre: 'FRA', french: 'FRA', francese: 'FRA',
    de: 'GER', deu: 'GER', ger: 'GER', german: 'GER', tedesco: 'GER',
    pt: 'POR', por: 'POR', portuguese: 'POR', portoghese: 'POR',
    ko: 'KOR', kor: 'KOR', korean: 'KOR', coreano: 'KOR',
    zh: 'CHI', zho: 'CHI', chi: 'CHI', chinese: 'CHI', cinese: 'CHI',
    ru: 'RUS', rus: 'RUS', russian: 'RUS', russo: 'RUS'
  };
  return map[value] || map[base] || (base.length === 2 || base.length === 3 ? base.toUpperCase() : null);
}

function inspectHls(sample = '') {
  if (!sample.includes('#EXTM3U')) return null;
  const languages = [];
  const resolutions = [];
  const bandwidths = [];
  const codecs = [];
  let durationSec = 0;

  for (const line of sample.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseHlsAttributes(line.slice(line.indexOf(':') + 1));
      if (String(attrs.TYPE || '').toUpperCase() === 'AUDIO') {
        const language = normalizeLanguageCode(attrs.LANGUAGE || attrs.NAME);
        if (language && !languages.includes(language)) languages.push(language);
      }
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseHlsAttributes(line.slice(line.indexOf(':') + 1));
      const resolution = String(attrs.RESOLUTION || '').match(/(\d+)x(\d+)/i);
      if (resolution) resolutions.push({ width: Number(resolution[1]), height: Number(resolution[2]) });
      const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || 0);
      if (bandwidth > 0) bandwidths.push(bandwidth);
      if (attrs.CODECS) codecs.push(attrs.CODECS);
    }
    if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice(8).split(',')[0]);
      if (Number.isFinite(seconds) && seconds > 0) durationSec += seconds;
    }
  }

  resolutions.sort((a, b) => b.height - a.height || b.width - a.width);
  bandwidths.sort((a, b) => b - a);
  return {
    languages,
    resolution: resolutions[0] || null,
    bandwidth: bandwidths[0] || null,
    codecs: [...new Set(codecs)],
    durationSec: durationSec > 0 ? durationSec : null
  };
}

export async function probeUrl(rawUrl, behaviorHints = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.PROBE_TIMEOUT_MS || 3500);
  const retryTimeoutMs = Number(options.retryTimeoutMs || Math.min(15000, Math.max(9000, timeoutMs * 3)));
  const cacheTtlMs = Number(options.cacheTtlMs || process.env.CACHE_TTL_MS || 45000);
  const allowPrivate = options.allowPrivate ?? envBool('ALLOW_PRIVATE_NETWORKS', false);
  const perHostLimit = Number(options.perHostLimit || process.env.PROBE_PER_HOST || 2);
  const cacheKey = `${rawUrl}|${JSON.stringify(behaviorHints?.proxyHeaders?.request || {})}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < (cached.ttlMs ?? cacheTtlMs)) return { ...cached.value, cached: true };

  let safeUrl;
  try {
    safeUrl = await assertSafeUrl(rawUrl, { allowPrivate });
  } catch (error) {
    const message = String(error?.message || 'blocked');
    return {
      state: 'unprobed', icon: '⚪', label: 'NOT PROBED', score: 2,
      status: null, latencyMs: 0, contentType: '', contentLength: null,
      hls: null, format: 'HTTP', error: message
    };
  }

  const releaseHost = await acquireHostSlot(safeUrl.host, Math.max(1, Math.min(4, perHostLimit)));
  const headers = normalizeHeaders(behaviorHints?.proxyHeaders?.request);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36';
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
    headers.Accept = 'application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,video/*,*/*;q=0.8';
  }

  async function attempt(limitMs) {
    const started = nowMs();
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), limitMs);
    let response;
    try {
      response = await fetch(safeUrl, {
        method: 'GET', headers, redirect: 'follow', signal: controller.signal
      });
      clearTimeout(headerTimer);
    } catch (error) {
      clearTimeout(headerTimer);
      throw error;
    }

    const latencyMs = Math.max(0, nowMs() - started);
    let sample = '';
    if (response.ok) {
      // Once headers arrived the endpoint is reachable. HLS inspection is best-effort and must not
      // turn a playable stream into a timeout merely because its body is slow to emit.
      const sampleTimer = setTimeout(() => controller.abort(), Math.min(1800, Math.max(700, limitMs / 3)));
      try { sample = await readSmallSample(response); } catch { sample = ''; }
      finally { clearTimeout(sampleTimer); }
    }
    const contentType = response.headers.get('content-type') || '';
    const format = inferFormat(safeUrl.href, contentType, sample);
    const meta = statusMeta(response.status);
    const hls = format === 'HLS' ? inspectHls(sample) : null;
    const contentLength = Number(response.headers.get('content-length') || 0) || null;
    return {
      ...meta,
      status: response.status,
      latencyMs,
      contentType,
      contentLength,
      format,
      hls,
      finalUrl: response.url || safeUrl.href
    };
  }

  try {
    let value;
    try {
      value = await attempt(timeoutMs);
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
      // Soft timeout: a player often waits longer than our fast diagnostic pass. Retry once before
      // calling the stream problematic.
      try {
        value = await attempt(retryTimeoutMs);
        value.retried = true;
        value.slow = true;
      } catch (retryError) {
        if (retryError?.name !== 'AbortError') throw retryError;
        value = {
          state: 'error', icon: '🟠', label: 'SLOW', score: 3,
          status: null, latencyMs: retryTimeoutMs, contentType: '', contentLength: null,
          hls: null, format: inferFormat(safeUrl.href), error: 'probe timeout',
          errorType: 'timeout', retried: true
        };
      }
    }

    // Timeouts/network errors are intentionally cached only briefly: they are often transient or
    // caused by CDN warm-up/rate limiting. Healthy results can live longer.
    let ttlMs = cacheTtlMs;
    if (value.state === 'dead') ttlMs = Math.min(cacheTtlMs, 20000);
    if (value.state === 'error') ttlMs = Math.min(cacheTtlMs, value.errorType === 'timeout' ? 4000 : 8000);
    cache.set(cacheKey, { at: Date.now(), ttlMs, value });
    return value;
  } catch (error) {
    const message = String(error?.message || 'network error');
    const value = {
      state: 'error', icon: '🟠', label: 'NETWORK ERROR', score: 3,
      status: null, latencyMs: 0, contentType: '', contentLength: null,
      hls: null, format: inferFormat(safeUrl.href), error: message, errorType: 'network'
    };
    cache.set(cacheKey, { at: Date.now(), ttlMs: Math.min(cacheTtlMs, 5000), value });
    return value;
  } finally {
    releaseHost();
  }
}

function streamKey(stream) {
  if (stream?.url) {
    const requestHeaders = stream?.behaviorHints?.proxyHeaders?.request || {};
    return `url:${stream.url}|headers:${JSON.stringify(requestHeaders)}`;
  }
  if (stream?.infoHash) return `torrent:${String(stream.infoHash).toLowerCase()}:${stream.fileIdx ?? ''}`;
  if (stream?.externalUrl) return `external:${stream.externalUrl}`;
  if (stream?.ytId) return `yt:${stream.ytId}`;
  return `json:${JSON.stringify(stream)}`;
}

export function roundRobinBySource(items, limit = Infinity) {
  const groups = new Map();
  for (const item of items) {
    const key = item.sourceKey || item.sourceName || 'Upstream';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()];
  const out = [];
  let progressed = true;
  while (progressed && out.length < limit) {
    progressed = false;
    for (const queue of queues) {
      if (queue.length && out.length < limit) {
        out.push(queue.shift());
        progressed = true;
      }
    }
  }
  return out;
}

function qualityRank(item) {
  return getStreamInfo(item.stream, item.probe).height || 0;
}

export function fairRankDiagnosed(items, limit = Infinity) {
  const statusBuckets = new Map();
  for (const item of items) {
    const score = item.classification?.score ?? item.sortScore ?? 2;
    if (!statusBuckets.has(score)) statusBuckets.set(score, []);
    statusBuckets.get(score).push(item);
  }

  const scores = [...statusBuckets.keys()].sort((a, b) => a - b);
  const out = [];
  for (const score of scores) {
    const bucket = statusBuckets.get(score);
    const qualityBuckets = new Map();
    for (const item of bucket) {
      const rank = qualityRank(item);
      if (!qualityBuckets.has(rank)) qualityBuckets.set(rank, []);
      qualityBuckets.get(rank).push(item);
    }

    const qualities = [...qualityBuckets.keys()].sort((a, b) => b - a);
    for (const quality of qualities) {
      const qualityBucket = qualityBuckets.get(quality);
      const perSource = new Map();
      for (const item of qualityBucket) {
        const key = item.sourceKey || item.sourceName || 'Upstream';
        if (!perSource.has(key)) perSource.set(key, []);
        perSource.get(key).push(item);
      }
      for (const queue of perSource.values()) {
        queue.sort((a, b) => (a.probe?.latencyMs ?? 999999) - (b.probe?.latencyMs ?? 999999));
      }
      const fair = roundRobinBySource(
        [...perSource.entries()].flatMap(([sourceKey, queue]) => queue.map((item) => ({ ...item, sourceKey }))),
        Math.max(0, limit - out.length)
      );
      out.push(...fair);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export function dedupeStreams(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = streamKey(item.stream);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function truncate(value, max = 500) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function streamText(stream, sourceName = '') {
  return [
    sourceName,
    stream?.name,
    stream?.title,
    stream?.description,
    stream?.url,
    stream?.externalUrl
  ].filter(Boolean).join(' ').toLowerCase();
}

function inferResolutionFromText(text = '') {
  const value = String(text).toLowerCase();
  const explicit = [...value.matchAll(/(?:^|[^\d])(2160|1440|1080|720|576|540|480|360)p\b/g)]
    .map((m) => Number(m[1]));
  if (/\b(?:8k|4320p)\b/.test(value)) explicit.push(4320);
  if (/\b(?:4k|uhd)\b/.test(value)) explicit.push(2160);
  if (/\b(?:2k|qhd)\b/.test(value)) explicit.push(1440);
  return explicit.length ? Math.max(...explicit) : 0;
}

function qualityLabel(height = 0) {
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 576) return '576p';
  if (height >= 480) return '480p';
  if (height > 0) return `${height}p`;
  return '';
}

function inferLanguagesFromText(text = '') {
  let value = ` ${String(text).toLowerCase()} `;
  // Do not call subtitle-only labels spoken audio.
  value = value
    .replace(/\b(?:sub|subs|subtitle|subtitles|sottotitoli?)\s*[:\-]?\s*(?:ita|italian|eng|english|jpn|jap|japanese|spa|spanish|fra|french|ger|german|por|portuguese|kor|korean|chi|chinese)\b/g, ' ')
    .replace(/\b(?:ita|eng|jpn|jap|spa|fra|ger|por|kor|chi)\s+(?:sub|subs|subtitle|subtitles)\b/g, ' ');

  const patterns = [
    ['ITA', /\b(?:ita|italian|italiano)\b/],
    ['ENG', /\b(?:eng|english|inglese)\b/],
    ['JPN', /\b(?:jpn|jap|japanese|giapponese)\b/],
    ['SPA', /\b(?:spa|spanish|spagnolo)\b/],
    ['FRA', /\b(?:fra|fre|french|francese)\b/],
    ['GER', /\b(?:ger|deu|german|tedesco)\b/],
    ['POR', /\b(?:por|portuguese|portoghese)\b/],
    ['KOR', /\b(?:kor|korean|coreano)\b/],
    ['CHI', /\b(?:chi|zho|chinese|cinese)\b/],
    ['RUS', /\b(?:rus|russian|russo)\b/]
  ];
  return patterns.filter(([, regex]) => regex.test(value)).map(([code]) => code);
}

export function getStreamInfo(stream, probe = null) {
  const text = [stream?.name, stream?.title, stream?.description, stream?.url].filter(Boolean).join(' ');
  const hlsHeight = probe?.hls?.resolution?.height || 0;
  const textHeight = inferResolutionFromText(text);
  const height = Math.max(hlsHeight, textHeight);

  const hlsLanguages = Array.isArray(probe?.hls?.languages) ? probe.hls.languages : [];
  const textLanguages = inferLanguagesFromText(text);
  const languages = [...new Set([...hlsLanguages, ...textLanguages])].slice(0, 3);

  const bandwidth = probe?.hls?.bandwidth || null;
  const durationSec = probe?.hls?.durationSec || null;
  let sizeBytes = probe?.contentLength || null;
  let estimatedSize = false;
  if (!sizeBytes && bandwidth && durationSec) {
    sizeBytes = (bandwidth / 8) * durationSec;
    estimatedSize = true;
  }

  return {
    height,
    quality: qualityLabel(height),
    languages,
    bandwidth,
    sizeBytes,
    estimatedSize
  };
}

function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '';
  return `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond >= 10_000_000 ? 1 : 2).replace(/\.0$/, '')} Mbps`;
}

function formatSize(bytes, estimated = false) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gib = bytes / (1024 ** 3);
  const mib = bytes / (1024 ** 2);
  const value = gib >= 0.95 ? `${gib.toFixed(gib >= 10 ? 1 : 2).replace(/\.0$/, '')} GB` : `${Math.round(mib)} MB`;
  return `${estimated ? '~' : ''}${value}`;
}

function compactOriginalLabel(stream, sourceName) {
  const raw = truncate(stream?.name || stream?.title || '', 70);
  if (!raw) return '';
  const normalizedRaw = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedSource = String(sourceName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedRaw || normalizedRaw === normalizedSource) return '';
  return raw;
}

export function classifyStream(stream, sourceName, probe) {
  if (probe?.state === 'dead') {
    return { state: 'dead', icon: '🔴', label: probe.label || 'DEAD', score: 4 };
  }

  const text = streamText(stream, sourceName);
  const isToastFlix = /toast\s*flix|toastflix/.test(text);
  const explicitDirect = /🎯|\bdirect(?:\s+hls)?\b|native\s+hls/.test(text);
  const extraPipeline = /\bsidecar\b|\bextractor\b|\bbrowser\b|\bremux\b|\bsync(?:hron(?:ize|isation|ization))?\b|local\s+(?:proxy|server)/.test(text);
  const likelyToastFlixPipeline = isToastFlix && !explicitDirect;
  const hasPipeline = extraPipeline || likelyToastFlixPipeline;

  // A timeout is not proof that a Sidecar/extractor stream is broken. Those pipelines often need
  // warm-up or extra processing and Nuvio can still play them after waiting longer.
  if (probe?.state === 'error' && probe?.errorType === 'timeout' && hasPipeline) {
    return {
      state: 'pipeline', icon: '🟡',
      label: extraPipeline && /sidecar/.test(text) ? 'SIDECAR' : 'PIPELINE', score: 1
    };
  }
  if (probe?.state === 'error') {
    return { state: 'error', icon: '🟠', label: probe.label || 'ERROR', score: 3 };
  }
  if (!stream?.url || !probe) {
    return { state: 'unprobed', icon: '⚪', label: 'NOT PROBED', score: 2 };
  }
  if (probe.state === 'healthy' && hasPipeline) {
    return {
      state: 'pipeline', icon: '🟡',
      label: extraPipeline && /sidecar/.test(text) ? 'SIDECAR' : 'PIPELINE', score: 1
    };
  }
  if (probe.state === 'healthy') {
    return { state: 'ready', icon: '🟢', label: 'READY', score: 0 };
  }
  return { state: 'unprobed', icon: '⚪', label: 'NOT PROBED', score: 2 };
}

export function decorateStream(stream, sourceName, probe) {
  const classification = classifyStream(stream, sourceName, probe);
  const info = getStreamInfo(stream, probe);
  const originalLabel = compactOriginalLabel(stream, sourceName);

  const headline = [
    classification.icon,
    info.quality,
    info.languages.length ? info.languages.join('/') : '',
    truncate(sourceName, 30)
  ].filter(Boolean).join(' • ');

  const details = [];
  if (classification.state === 'pipeline') {
    details.push(classification.label === 'SIDECAR' ? 'Sidecar' : 'Pipeline');
    if (probe?.errorType === 'timeout') details.push('Slow probe');
  }
  if (classification.state === 'error') details.push(classification.label === 'SLOW' ? 'Slow probe' : classification.label);
  if (classification.state === 'dead') details.push(classification.label);
  if (classification.state === 'unprobed') details.push('Not probed');
  if (originalLabel && !headline.toLowerCase().includes(originalLabel.toLowerCase())) details.push(originalLabel);
  if (probe?.format) details.push(probe.format);
  const bitrate = formatBitrate(info.bandwidth);
  if (bitrate) details.push(bitrate);
  const size = formatSize(info.sizeBytes, info.estimatedSize);
  if (size) details.push(size);
  if (Number.isFinite(probe?.latencyMs)) details.push(`${probe.latencyMs}ms`);

  return {
    ...stream,
    name: headline || `${classification.icon} • ${truncate(sourceName, 30)}`,
    description: details.slice(0, 5).join(' • ')
  };
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
