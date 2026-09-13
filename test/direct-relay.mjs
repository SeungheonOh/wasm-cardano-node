// This diagnostic deliberately has no WebSocket-to-TCP bridge.
// The HTTP server serves only the empty test page. Chromium connects straight
// to the relay addresses. A separate Node TCP control checks peer availability.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { liveStream } from './runtime.mjs';

const relays = [
  { host: 'backbone.cardano.iog.io', port: 3001, magic: 764824073 },
  { host: 'preview-node.play.dev.cardano.org', port: 3001, magic: 2 },
];
const urls = process.argv.slice(2);
if (!urls.length) for (const relay of relays) {
  urls.push(`ws://${relay.host}:${relay.port}/`, `wss://${relay.host}:${relay.port}/`);
}
for (const url of urls) {
  if (!['ws:', 'wss:'].includes(new URL(url).protocol)) throw new Error('Expected ws:// or wss:// URL');
}
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.end('<!doctype html><title>Direct relay transport probe</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', message => logs.push(message.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const capabilities = await page.evaluate(() => ({
    secure: isSecureContext, crossOriginIsolated,
    TCPSocket: typeof globalThis.TCPSocket,
    WebSocket: typeof globalThis.WebSocket,
    WebTransport: typeof globalThis.WebTransport,
    chromeSockets: typeof globalThis.chrome?.sockets,
  }));
  const results = await page.evaluate(async urls => Promise.all(urls.map(url => new Promise(resolve => {
    const started = performance.now();
    let socket, settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, outcome, milliseconds: Math.round(performance.now() - started) });
      socket?.close();
    };
    const timer = setTimeout(() => finish('Timed out waiting for WebSocket upgrade'), 15000);
    try {
      socket = new WebSocket(url);
      socket.onopen = () => finish('WebSocket accepted (Ouroboros compatibility not yet tested)');
      socket.onerror = () => finish('WebSocket connection failed');
      socket.onclose = () => finish('Connection closed before WebSocket upgrade');
    } catch (error) { finish(error.message); }
  }))), urls);
  const controls = [];
  // Sequential: the WASM test harness uses one transport per JS global.
  for (const relay of relays) {
    let connected = false, version;
    try {
      await liveStream({ ...relay, seconds: 2, blocks: false, onEvent: event => {
        if (event.type === 'connected') { connected = true; version = event.version; }
      } });
      controls.push({ ...relay, runtime: 'Node.js direct TCP, not a browser connection', connected, version });
    } catch (error) {
      controls.push({ ...relay, runtime: 'Node.js direct TCP, not a browser connection', connected, error: error.message });
    }
  }
  const evidence = { testedAt: new Date().toISOString(), browser: browser.version(),
    capabilities, results, controls, logs };
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('../evidence/direct-relay-probe.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
