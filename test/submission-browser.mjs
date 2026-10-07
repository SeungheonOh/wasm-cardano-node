import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startIWA } from '../iwa.mjs';
import { localSubmissionPeer } from './submission-peer.mjs';

const root = new URL('../', import.meta.url);
const transaction = JSON.parse(await readFile(new URL('test/fixtures/mainnet.json', root))).transactions[0];
await mkdir(new URL('evidence/', root), { recursive: true });
const profile = await mkdtemp(new URL('build/submit-test-', root).pathname);
// Real nodes delay their first request by 60 seconds. Go beyond that to catch
// both an incorrect protocol idle timeout and a too-short Worker deadline.
const initialDelayMs = 65000;
const peer = await localSubmissionPeer({ transaction, initialDelayMs });
const skippedPeer = await localSubmissionPeer({ transaction, mode: 'not-requested' });
const idlePeer = await localSubmissionPeer({ transaction, mode: 'idle' });
let context, preview;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/snap/bin/chromium', headless: true,
    args: ['--enable-features=IsolatedWebApps,IsolatedWebAppDevMode',
      `--install-isolated-web-app-from-file=${new URL('dist/cardano-submit.swbn', root).pathname}`],
    viewport: { width: 1280, height: 1100 },
  });
  const installer = context.pages()[0];
  await installer.goto('chrome://web-app-internals');
  let app, state;
  for (let attempt = 0; attempt < 60 && !app; attempt++) {
    await installer.reload();
    await installer.locator('#json').filter({ hasText: /\S/ }).waitFor({ state: 'attached' });
    state = JSON.parse(await installer.locator('#json').textContent());
    app = state.InstalledWebApps.Details.find(app => app.start_url?.startsWith('isolated-app:'));
    if (!app) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(app, `Signed submission bundle must install: ${JSON.stringify(state)}`);
  const page = await context.newPage();
  const errors = [], webSockets = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('websocket', socket => webSockets.push(socket.url()));
  page.on('request', request => requests.push(request.url()));
  await page.goto(app.start_url);
  const capability = await page.evaluate(() => ({ isolated: crossOriginIsolated, tcp: typeof TCPSocket }));
  assert.deepEqual(capability, { isolated: true, tcp: 'function' });
  const cdp = await context.newCDPSession(page);
  // Equivalent to allowing the local-network prompt for our loopback test peer.
  await cdp.send('Browser.grantPermissions', { origin: app.start_url,
    permissions: ['localNetworkAccess', 'localNetwork', 'loopbackNetwork'] });
  const ready = async () => {
    await page.waitForFunction(() => !document.querySelector('#ready').hidden || !document.querySelector('#error').hidden);
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert.equal(await page.locator('#tx-id').textContent(), transaction.id);
  };
  const finished = async () => {
    await page.waitForFunction(() => document.querySelector('#cancel').hidden, null, { timeout: initialDelayMs + 15000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
  };
  await page.screenshot({ path: new URL('evidence/submission-empty.png', root).pathname, fullPage: true });
  // A real file drop, not a mocked worker or transport.
  await page.evaluate(hex => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16))], 'transaction.cbor', { type: 'application/cbor' }));
    document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, transaction.cborHex);
  await ready();
  assert.equal(peer.peers.length, 0, 'Dropping and reviewing cannot initiate a relay connection');
  assert.equal(await page.locator('#witnesses').textContent(), '2');
  await page.locator('#relay').fill(peer.url);
  const submittedAt = Date.now();
  await page.locator('#send').click();
  await finished();
  assert.equal(await page.locator('#status-title').textContent(), 'Sent to relay');
  assert.equal(await page.locator('.progress .done').count(), 4);
  assert.equal(peer.peers.length, 1);
  assert.equal(peer.peers[0].delivered, transaction.cborHex);
  assert(peer.peers[0].firstRequestAt - submittedAt >= initialDelayMs);
  assert.match(await page.locator('#elapsed').textContent(), /^1:0[5-9] elapsed$/);
  assert.match(await page.locator('#health').textContent(), /^Relay response/);
  assert(peer.peers[0].records.filter(record => record.protocol === 8).length >= 6, 'KeepAlive continues throughout relay startup');
  assert.deepEqual([...peer.peers[0].protocols].sort(), [0, 4, 8]);
  const memory = await page.locator('#memory').textContent();
  await page.screenshot({ path: new URL('evidence/submission-desktop.png', root).pathname, fullPage: true });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => ({ fits: document.documentElement.scrollWidth <= innerWidth,
      overflow: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth)
        .map(el => ({ tag: el.tagName, id: el.id, class: el.className })) }));
    assert(layout.fits, `Layout fits ${width}px: ${JSON.stringify(layout.overflow)}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL('evidence/submission-mobile.png', root).pathname, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator('#file').setInputFiles({ name: 'transaction.signed', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ type: 'Tx ConwayEra', description: '送信', cborHex: transaction.cborHex })) });
  await ready();
  await page.locator('#relay').fill(skippedPeer.url);
  await page.locator('#send').click();
  await finished();
  assert.equal(await page.locator('#status-title').textContent(), 'Relay did not request this transaction');
  assert.equal(skippedPeer.peers[0].delivered, undefined);
  assert.equal(await page.locator('[data-stage=sent].done').count(), 0);
  await page.locator('#cbor').fill(transaction.cborHex);
  await page.locator('#inspect').click();
  await ready();
  await page.locator('#relay').fill(idlePeer.url);
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('[data-stage=connected]').classList.contains('done'));
  assert(await page.locator('#clear').isDisabled());
  await page.locator('#cancel').click();
  assert.equal(await page.locator('#status-title').textContent(), 'Connection closed');
  assert.equal(idlePeer.peers[0].delivered, undefined);
  // Exercise the app deadline without spending three minutes on a silent peer.
  // Only this Worker timer is accelerated; WASM/KeepAlive timers remain real.
  await page.locator('#cbor').fill(transaction.cborHex);
  await page.locator('#inspect').click();
  await ready();
  await page.workers().at(-1).evaluate(() => {
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 180000 ? 300 : delay, ...args);
  });
  await page.locator('#send').click();
  await page.locator('#error').waitFor();
  assert.match(await page.locator('#error').textContent(), /did not request a transaction ID/);
  assert.match(await page.locator('#status-note').textContent(), /No transaction body was sent/);
  assert.equal(idlePeer.peers.at(-1).delivered, undefined);
  await page.locator('#cbor').fill(transaction.cborHex + '00');
  await page.locator('#inspect').click();
  await page.locator('#error').waitFor();
  assert(await page.locator('#send').isDisabled());
  assert.equal(peer.peers.length, 1);
  assert.deepEqual([...peer.errors, ...skippedPeer.errors, ...idlePeer.errors], []);
  assert.deepEqual(errors, []);
  assert.deepEqual(webSockets, []);
  assert(requests.every(url => url.startsWith(app.start_url)), 'All app assets came from the installed bundle');

  // Ordinary tabs can review files, but have no submission/bridge fallback.
  preview = await startIWA({ app: 'submit', port: 0 });
  const tab = await context.newPage();
  await tab.goto(preview.url);
  await tab.locator('#cbor').fill(transaction.cborHex);
  await tab.locator('#inspect').click();
  await tab.locator('#ready').waitFor();
  assert(await tab.locator('#install').isVisible());
  assert(await tab.locator('#send').isDisabled());
  for (const path of ['/submit/../build/not-served', '/dist/%2e%2e/build/not-served', '/config.json']) {
    const response = await fetch(preview.url + path);
    assert.equal(response.status, path === '/config.json' ? 200 : 404);
  }
  const result = { testedAt: new Date().toISOString(), browser: context.browser().version(),
    origin: app.start_url, capability, memory, exactTransactionReceived: peer.peers[0].delivered === transaction.cborHex,
    protocols: [...peer.peers[0].protocols].sort(), noAppServerDuringSubmission: true,
    initialDelayMs, publicChainBroadcasts: 0, binaryDrop: true, jsonFile: true, hexPaste: true,
    notRequestedAndCancelChecked: true, deadlineChecked: true, invalidInputBlocked: true, normalTabSubmitDisabled: true,
    widths: [320, 390, 768, 1280], webSockets, errors };
  await writeFile(new URL('evidence/submission-browser.json', root), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  await preview?.close();
  await peer.close(); await skippedPeer.close(); await idlePeer.close();
  await rm(profile, { recursive: true, force: true });
}
