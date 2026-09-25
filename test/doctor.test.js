import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classifyStream, decorateStream, dedupeStreams, fairRankDiagnosed, getStreamInfo, probeUrl, roundRobinBySource } from '../src/doctor.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test('healthy HLS is detected and HLS metadata is inspected', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="it",NAME="Italiano",DEFAULT=YES,AUTOSELECT=YES',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English",DEFAULT=NO,AUTOSELECT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=14000000,RESOLUTION=3840x2160,AUDIO="aud"',
      'video.m3u8'
    ].join('\n'));
  });
  const port = await listen(server);
  try {
    const result = await probeUrl(`http://127.0.0.1:${port}/live.m3u8`, {}, { allowPrivate: true, cacheTtlMs: 1 });
    assert.equal(result.state, 'healthy');
    assert.equal(result.format, 'HLS');
    assert.equal(result.status, 200);
    assert.deepEqual(result.hls.languages, ['ITA', 'ENG']);
    assert.equal(result.hls.resolution.height, 2160);
    assert.equal(result.hls.bandwidth, 14000000);
  } finally { await close(server); }
});

test('404 is classified as dead', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('no'); });
  const port = await listen(server);
  try {
    const result = await probeUrl(`http://127.0.0.1:${port}/gone`, {}, { allowPrivate: true, cacheTtlMs: 1 });
    assert.equal(result.state, 'dead');
    assert.equal(result.status, 404);
  } finally { await close(server); }
});

test('decorator is minimal and preserves original stream URL and hints', () => {
  const stream = { url: 'https://example.com/a.m3u8', title: '4K ITA', behaviorHints: { notWebReady: true } };
  const out = decorateStream(stream, 'Example', {
    state: 'healthy', icon: '🟢', label: 'READY', latencyMs: 50, format: 'HLS',
    hls: { languages: ['ITA'], resolution: { width: 3840, height: 2160 }, bandwidth: 14000000 }
  });
  assert.equal(out.url, stream.url);
  assert.deepEqual(out.behaviorHints, stream.behaviorHints);
  assert.match(out.name, /^🟢 • 4K • ITA • Example$/);
  assert.doesNotMatch(out.description, /Source:/);
  assert.doesNotMatch(out.description, /READY/);
  assert.match(out.description, /HLS/);
  assert.match(out.description, /14 Mbps/);
});

test('language inference ignores subtitle-only ITA labels', () => {
  const withSubsOnly = getStreamInfo({ name: '1080p ENG SUB ITA' }, null);
  assert.deepEqual(withSubsOnly.languages, ['ENG']);
  const dual = getStreamInfo({ name: '1080p Dual Audio ITA ENG' }, null);
  assert.deepEqual(dual.languages, ['ITA', 'ENG']);
});

test('dedupe removes identical URLs', () => {
  const items = [
    { sourceName: 'A', stream: { url: 'https://x.test/a' } },
    { sourceName: 'B', stream: { url: 'https://x.test/a' } }
  ];
  assert.equal(dedupeStreams(items).length, 1);
});

test('ToastFlix non-direct healthy stream is yellow pipeline', () => {
  const stream = { url: 'https://example.com/watch.m3u8', name: 'ToastFlix 4K Dual', description: 'Sidecar audio ITA' };
  const c = classifyStream(stream, 'ToastFlix', { state: 'healthy', status: 200, latencyMs: 80, format: 'HLS' });
  assert.equal(c.state, 'pipeline');
  assert.equal(c.icon, '🟡');
});

test('ToastFlix direct stream is green', () => {
  const stream = { url: 'https://example.com/direct.m3u8', name: '🎯 Direct HLS 1080p' };
  const c = classifyStream(stream, 'ToastFlix', { state: 'healthy', status: 200, latencyMs: 80, format: 'HLS' });
  assert.equal(c.state, 'ready');
  assert.equal(c.icon, '🟢');
});

test('403 is orange and 410 is red', () => {
  const stream = { url: 'https://example.com/a.m3u8', name: 'Example' };
  const orange = classifyStream(stream, 'Example', { state: 'error', label: 'HTTP 403' });
  const red = classifyStream(stream, 'Example', { state: 'dead', label: 'DEAD 410' });
  assert.equal(orange.icon, '🟠');
  assert.equal(red.icon, '🔴');
});

test('round-robin keeps later providers from being starved', () => {
  const items = [
    ...Array.from({ length: 20 }, (_, i) => ({ sourceName: 'ToastFlix', sourceKey: 'toast', stream: { url: `https://toast.test/${i}` } })),
    { sourceName: 'EasyStreams', sourceKey: 'easy', stream: { url: 'https://easy.test/1' } },
    { sourceName: 'EasyStreams', sourceKey: 'easy', stream: { url: 'https://easy.test/2' } }
  ];
  const out = roundRobinBySource(items, 6);
  assert.equal(out.filter((x) => x.sourceKey === 'easy').length, 2);
  assert.equal(out[1].sourceKey, 'easy');
});

test('ranking is status first then quality descending', () => {
  const mk = (sourceKey, icon, score, quality, state = 'ready') => ({
    sourceKey,
    sourceName: sourceKey,
    stream: { name: quality, url: `https://${sourceKey}/${quality}` },
    probe: { state: 'healthy', latencyMs: 10, format: 'HLS' },
    classification: { icon, score, state }
  });
  const items = [
    mk('a', '🟢', 0, '720p'),
    mk('b', '🟡', 1, '4K', 'pipeline'),
    mk('c', '🟢', 0, '1080p'),
    mk('d', '🟢', 0, '4K')
  ];
  const out = fairRankDiagnosed(items, 10);
  assert.deepEqual(out.map((x) => x.stream.name), ['4K', '1080p', '720p', '4K']);
  assert.equal(out[3].classification.icon, '🟡');
});


test('probe retries a slow first response before marking it as timeout', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        if (!res.writableEnded) res.end('#EXTM3U\n');
      }, 120);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n');
  });
  const port = await listen(server);
  try {
    const result = await probeUrl(`http://127.0.0.1:${port}/slow.m3u8`, {}, {
      allowPrivate: true, cacheTtlMs: 1, timeoutMs: 30, retryTimeoutMs: 300
    });
    assert.equal(result.state, 'healthy');
    assert.equal(result.retried, true);
    assert.equal(result.slow, true);
    assert.ok(calls >= 2);
  } finally { await close(server); }
});

test('sidecar probe timeout stays yellow rather than orange', () => {
  const stream = { url: 'https://example.com/sidecar', name: 'ToastFlix Sidecar ITA 1080p' };
  const c = classifyStream(stream, 'ToastFlix', {
    state: 'error', label: 'SLOW', errorType: 'timeout', format: 'HTTP'
  });
  assert.equal(c.icon, '🟡');
  assert.equal(c.state, 'pipeline');
});
