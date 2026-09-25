import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequestListener } from '../src/app.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

test('configured middleware aggregates and diagnoses upstream streams', async () => {
  process.env.ALLOW_PRIVATE_NETWORKS = 'true';
  process.env.PROBE_TIMEOUT_MS = '1200';
  process.env.CACHE_TTL_MS = '1';

  let mediaPort;
  const media = http.createServer((req, res) => {
    if (req.url === '/ok.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n');
    }
    res.writeHead(410); res.end('gone');
  });
  mediaPort = await listen(media);

  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/manifest.json') return res.end(JSON.stringify({
      id: 'test.upstream', name: 'Test Upstream', version: '1.0.0',
      resources: ['stream'], types: ['movie', 'series'], catalogs: []
    }));
    if (req.url?.startsWith('/stream/movie/tt123')) return res.end(JSON.stringify({ streams: [
      { name: 'Good', url: `http://127.0.0.1:${mediaPort}/ok.m3u8` },
      { name: 'Gone', url: `http://127.0.0.1:${mediaPort}/gone.m3u8` },
      { name: 'Torrent', infoHash: 'ABCDEF', fileIdx: 0 }
    ] }));
    res.statusCode = 404; res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdoctor-test-'));
  const handler = await createRequestListener({ dataDir: dir });
  const doctor = http.createServer(handler);
  const doctorPort = await listen(doctor);

  try {
    const configResponse = await fetch(`http://127.0.0.1:${doctorPort}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreams: `http://127.0.0.1:${upstreamPort}/manifest.json`, hideDead: true, probeTimeoutMs: 1200, maxStreams: 20 })
    });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    const streamResponse = await fetch(`http://127.0.0.1:${doctorPort}/${config.id}/stream/movie/tt123.json`);
    const payload = await streamResponse.json();
    assert.equal(payload.streams.length, 2);
    assert.match(payload.streams[0].name, /^🟢/);
    assert.doesNotMatch(payload.streams[0].description, /Source:/);
    assert.ok(payload.streams.some((s) => s.infoHash === 'ABCDEF'));
    assert.ok(!payload.streams.some((s) => s.name?.includes('Gone')));
  } finally {
    await Promise.all([close(doctor), close(upstream), close(media)]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('configured middleware preserves query config and fairly includes later upstream streams', async () => {
  process.env.ALLOW_PRIVATE_NETWORKS = 'true';
  process.env.CACHE_TTL_MS = '1';

  const media = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n');
  });
  const mediaPort = await listen(media);

  const noisy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/manifest.json') return res.end(JSON.stringify({
      id: 'noisy', name: 'ToastFlix-ish', version: '1', resources: ['stream'], types: ['movie'], catalogs: []
    }));
    if (req.url?.startsWith('/stream/movie/ttfair')) {
      return res.end(JSON.stringify({ streams: Array.from({ length: 60 }, (_, i) => ({
        name: `Noisy ${i}`, url: `http://127.0.0.1:${mediaPort}/n${i}.m3u8`
      })) }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const noisyPort = await listen(noisy);

  const easy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/alias/manifest.json?token=abc') {
      res.statusCode = 302;
      res.setHeader('location', '/configured/manifest.json?token=abc');
      return res.end();
    }
    if (req.url === '/configured/manifest.json?token=abc') return res.end(JSON.stringify({
      id: 'easy', name: 'EasyStreams', version: '1', resources: ['stream'], types: ['movie'], catalogs: []
    }));
    if (req.url === '/configured/stream/movie/ttfair.json?token=abc') {
      return res.end(JSON.stringify({ streams: [
        { name: 'Easy green 1', url: `http://127.0.0.1:${mediaPort}/e1.m3u8` },
        { name: 'Easy green 2', url: `http://127.0.0.1:${mediaPort}/e2.m3u8` }
      ] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const easyPort = await listen(easy);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamdoctor-fair-test-'));
  const handler = await createRequestListener({ dataDir: dir });
  const doctor = http.createServer(handler);
  const doctorPort = await listen(doctor);

  try {
    const configResponse = await fetch(`http://127.0.0.1:${doctorPort}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreams: `http://127.0.0.1:${noisyPort}/manifest.json\nhttp://127.0.0.1:${easyPort}/alias/manifest.json?token=abc`,
        probeTimeoutMs: 1200,
        upstreamTimeoutMs: 5000,
        maxStreams: 10
      })
    });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    const streamResponse = await fetch(`http://127.0.0.1:${doctorPort}/${config.id}/stream/movie/ttfair.json`);
    const payload = await streamResponse.json();
    assert.equal(payload.streams.length, 10);
    assert.ok(payload.streams.some((s) => s.name.includes('EasyStreams')));
    assert.ok(payload.streams.filter((s) => s.name.includes('EasyStreams')).length >= 2);
  } finally {
    await Promise.all([close(doctor), close(noisy), close(easy), close(media)]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
