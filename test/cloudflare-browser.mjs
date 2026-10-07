import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from 'playwright-core';
import { relayBridgeURL } from '../web/relay-url.mjs';
import { localSubmissionPeer } from './submission-peer.mjs';
import { localChainPeer } from './chain-peer.mjs';

const root = new URL('../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('test/fixtures/mainnet.json', root)));
const peer = await localChainPeer(fixture);
const transaction = fixture.transactions[0];
const initialDelayMs = Number(process.env.SUBMISSION_DELAY_MS ?? 65000);
const submitPeer = await localSubmissionPeer({ transaction, initialDelayMs });
const skippedPeer = await localSubmissionPeer({ transaction, mode: 'not-requested' });
const idlePeer = await localSubmissionPeer({ transaction, mode: 'idle' });
let mf, browser;
try {
  // Run the unchanged Worker. The browser enters a custom TCP address and port;
  // workerd's local network access lets this use a local captured-chain peer.
  const bundle = await build({ entryPoints: [new URL('cloudflare/worker.ts', root).pathname],
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:sockets'],
  });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'cardano-live-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-13', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
    assets: { directory: new URL('build/cloudflare-assets/', root).pathname, run_worker_first: ['/ouroboros'],
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: '404-page' } },
    ratelimits: { PER_IP: { namespace_id: '913202601', simple: { limit: 4, period: 60 } },
      PER_LOCATION: { namespace_id: '913202602', simple: { limit: 30, period: 60 } } },
  }));
  const base = (await mf.ready).origin;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/snap/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [], sockets = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  let releaseUI;
  const uiGate = new Promise(resolve => { releaseUI = resolve; });
  await page.route('**/dist/chain-ui.mjs', async route => { await uiGate; await route.continue(); });
  const runtimeRequests = [];
  page.on('request', request => { if (/\.wasm(\.gz)?$/.test(new URL(request.url()).pathname)) runtimeRequests.push(request.url()); });
  let releaseConfig;
  const configGate = new Promise(resolve => { releaseConfig = resolve; });
  await page.route('**/config.json', async route => { await configGate; await route.continue(); });
  await page.goto(base, { waitUntil: 'commit' });
  await page.locator('#connect').waitFor();
  assert(await page.locator('#connect').isDisabled(), 'Connect waits for settings instead of dropping an early click');
  // All controls and both navigation tabs are present before React loads.
  assert(await page.locator('#chain').isVisible());
  assert(await page.locator('#activity').isVisible());
  assert(await page.locator('#transaction-search').isVisible());
  assert(await page.getByRole('link', { name: 'Submit transaction', exact: true }).isVisible());
  assert.equal(await page.locator('h1').count(), 0);
  assert.equal(await page.locator('#composition').count(), 0);
  assert.equal(runtimeRequests.length, 0);
  releaseUI();
  releaseConfig();
  assert.equal(await page.title(), 'Chain');
  await page.waitForFunction(() => document.querySelector('#url').value.startsWith('tcp://'));
  assert.equal(await page.evaluate(() => typeof TCPSocket), 'undefined');
  await page.locator('#network').selectOption('2');
  assert.equal(await page.locator('#url').inputValue(), 'tcp://preview-node.play.dev.cardano.org:3001');
  await page.locator('#network').selectOption('764824073');
  assert.equal(peer.peers.length, 0, 'The dashboard waits for Connect');
  await page.locator('#url').fill(peer.url);
  await page.locator('#connect').click();
  await page.waitForFunction(() => Number(document.querySelector('#txs').textContent) > 0);
  assert.equal(await page.locator('#txs').textContent(), String(fixture.transactions.length));
  assert.deepEqual([...peer.peers[0].protocols].sort(), [0, 2, 3, 8]);
  assert.equal(new URL(sockets[0]).searchParams.get('url'), peer.url);
  assert((await page.locator('#relay-host').textContent()).includes(peer.url.slice(6)), 'Telemetry reflects the entered relay');
  assert.equal(await page.locator('#block-rows tr').count(), 1);
  assert(await page.locator('#activity #transaction-search').isVisible(), 'Search belongs to recent blocks');
  assert.equal(await page.locator('.metrics-details[open]').count(), 0);
  assert(await page.locator('#chain').evaluate(el => el.getBoundingClientRect().height < 220), 'Chain summary stays compact');
  assert(await page.locator('#activity').evaluate(el => el.previousElementSibling.classList.contains('columns')), 'Recent blocks directly follow compact metrics');
  await page.getByText('Chain details', { exact: true }).click();
  assert(await page.locator('#count').isVisible());
  await page.getByText('Chain details', { exact: true }).click();
  await page.getByText('Relay details', { exact: true }).click();
  assert(await page.locator('#relay-host').isVisible());
  await page.getByText('Relay details', { exact: true }).click();
  const block = page.locator('#block-rows button').first();
  await block.click();
  assert.equal(await page.locator('#block-hash').textContent(), await block.getAttribute('data-hash'));
  assert.equal(await page.locator('#block-modal .tx-card').count(), fixture.transactions.length);
  assert.match(await page.locator('#epoch').textContent(), /^\d+$/);
  const card = page.locator('.tx-card').first();
  await card.locator(':scope > summary').click();
  assert.match(await card.locator('.output-address').first().textContent(), /^addr1/);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.locator('#block-modal').evaluate(el => el.scrollWidth <= el.clientWidth), `Block modal fits ${width}px`);
  }
  await page.screenshot({ path: new URL('evidence/cloudflare-block-local.png', root).pathname });
  await page.getByRole('button', { name: 'Close block' }).click();
  assert.equal(await page.locator('.tx-card').count(), 0, 'Transaction details exist only inside the block modal');
  const search = page.getByRole('searchbox', { name: 'Search transactions' });
  const matched = fixture.transactions.at(-1);
  await search.fill(matched.id.toUpperCase());
  await search.press('Enter');
  const highlighted = page.locator('.tx-highlight');
  assert.equal(await highlighted.getAttribute('data-tx-id'), matched.id);
  assert.equal(await highlighted.getAttribute('open'), '');
  await highlighted.getByText('Raw transaction CBOR', { exact: true }).click();
  assert.equal(await highlighted.locator('.raw-detail').last().locator('pre').textContent(), matched.cborHex);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#block-modal').count(), 0);
  await search.fill(matched.id.slice(0, 10));
  await page.locator('.search-results button').first().click();
  assert.equal(await page.locator('.tx-highlight').getAttribute('data-tx-id'), matched.id);
  await page.getByRole('button', { name: 'Close block' }).click();
  await search.fill('no-matching-transaction');
  await search.press('Enter');
  await page.getByText('No matching transaction in the observed blocks.').waitFor();
  assert.equal(await page.locator('#block-modal').count(), 0);
  await search.fill('');
  await page.locator('#stop').click();
  assert.equal(await page.locator('#state').textContent(), 'Disconnected');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Fits ${width}px`);
  }
  await page.screenshot({ path: new URL('evidence/cloudflare-dashboard-local.png', root).pathname, fullPage: true });
  await page.getByRole('link', { name: 'Submit transaction', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#app-tabs')?.hidden === false);
  assert.equal(new URL(page.url()).pathname, '/submit/');
  assert(await page.locator('#install').isHidden());
  const ready = async () => {
    try { await page.waitForFunction(() => !document.querySelector('#ready').hidden || !document.querySelector('#error').hidden); }
    catch (error) { console.error(JSON.stringify({ errors, status: await page.locator('#status-title').textContent(), log: await page.locator('#log').textContent() })); throw error; }
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert.equal(await page.locator('#tx-id').textContent(), transaction.id);
    assert(await page.locator('#send').isEnabled());
  };
  await page.waitForFunction(() => !document.querySelector('#choose-file').disabled);
  // A file drop only decodes in WASM; this local peer never forwards to a chain.
  await page.evaluate(hex => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16))], 'transaction.cbor', { type: 'application/cbor' }));
    document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, transaction.cborHex);
  await ready();
  assert.equal(submitPeer.peers.length, 0);
  assert.equal(sockets.length, 1, 'Review does not open a relay connection');
  await page.locator('#relay').fill(submitPeer.url);
  const began = Date.now();
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#cancel').hidden, null, { timeout: 80000 });
  assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
  assert.equal(await page.locator('#status-title').textContent(), 'Sent to relay');
  assert.equal(submitPeer.peers[0].delivered, transaction.cborHex);
  assert(submitPeer.peers[0].firstRequestAt - began >= initialDelayMs);
  assert(submitPeer.peers[0].records.filter(record => record.protocol === 8).length >= Math.floor(initialDelayMs / 10000));
  assert.deepEqual([...submitPeer.peers[0].protocols].sort(), [0, 4, 8]);
  assert.equal(new URL(sockets[1]).searchParams.get('url'), submitPeer.url);
  await page.screenshot({ path: new URL('evidence/cloudflare-submission-local.png', root).pathname, fullPage: true });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Submission fits ${width}px`);
    const layout = await page.evaluate(() => {
      const transaction = document.querySelector('.transaction-panel').getBoundingClientRect();
      const submit = document.querySelector('.submit-panel').getBoundingClientRect();
      return { left: transaction.left, right: submit.left, reviewEnd: transaction.bottom, submitStart: submit.top };
    });
    if (width <= 768) assert(layout.submitStart >= layout.reviewEnd, 'Mobile submission follows transaction review');
    else assert(layout.right > layout.left, 'Desktop groups destination and status beside the transaction');
    if (width === 390) await page.screenshot({ path: new URL('evidence/cloudflare-submission-local-mobile.png', root).pathname, fullPage: true });
  }
  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('#choose-file').click();
  await (await fileChooser).setFiles({ name: 'transaction.signed', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ type: 'Tx ConwayEra', cborHex: transaction.cborHex })) });
  await ready();
  await page.locator('#relay').fill(skippedPeer.url);
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#cancel').hidden);
  assert.equal(await page.locator('#status-title').textContent(), 'Relay did not request this transaction');
  assert.equal(skippedPeer.peers[0].delivered, undefined);
  await page.locator('#cbor').fill(transaction.cborHex);
  await page.locator('#inspect').click();
  await ready();
  await page.locator('#relay').fill(idlePeer.url);
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('[data-stage=connected]').classList.contains('done'));
  await page.locator('#cancel').click();
  assert.equal(await page.locator('#status-title').textContent(), 'Connection closed');
  assert.equal(idlePeer.peers[0].delivered, undefined);
  await page.locator('#cbor').fill(transaction.cborHex + '00');
  await page.locator('#inspect').click();
  await page.locator('#error').waitFor();
  assert(await page.locator('#send').isDisabled());
  await page.getByRole('link', { name: 'Chain', exact: true }).click();
  await page.locator('#connect').waitFor();
  assert.deepEqual(errors, []);
  const bridgeURL = new URL(relayBridgeURL(peer.url, base));
  const defaultPath = bridgeURL.pathname + bridgeURL.search;
  const request = (path = defaultPath, origin = base) => mf.dispatchFetch(base + path,
    { headers: { Upgrade: 'websocket', Origin: origin, 'CF-Connecting-IP': '192.0.2.100' } });
  assert.equal((await request(defaultPath, 'https://attacker.example')).status, 403);
  assert.equal((await request('/ouroboros?relay=arbitrary')).status, 400);
  assert.equal((await request(defaultPath + '&host=127.0.0.1')).status, 400);
  assert.equal((await request('/ouroboros?url=https://example.com:443')).status, 400);
  assert.equal((await mf.dispatchFetch(base + '/ouroboros')).status, 426);
  for (let i = 0; i < 4; i++) {
    const response = await request(); assert.equal(response.status, 101);
    response.webSocket.accept(); response.webSocket.close();
  }
  const limited = await request();
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
  for (const path of ['/build/submission-development-key.pem', '/evidence/user-submission.hex', '/dist/cardano-stream.wasm'])
    assert.equal((await mf.dispatchFetch(base + path)).status, 404);
  assert.deepEqual([...peer.errors, ...submitPeer.errors, ...skippedPeer.errors, ...idlePeer.errors], []);
  const result = { testedAt: new Date().toISOString(), dashboard: true, blocksDecoded: 1, transactions: fixture.transactions.length, browser: browser.version(),
    prerenderedUI: true, lazyWasm: true, blockModal: true, transactionSearchAndHighlight: true, customFileChooser: true, submissionFlow: true, compactSummaries: true, blockTables: true, submissionTab: true, exactSubmissionBytes: true, delayedSubmissionMs: initialDelayMs, reviewOnlyDoesNotConnect: true, cancellation: true, normalBrowser: true, workerRuntime: 'workerd', rateLimit429: true,
    customRelayURL: true, originAndURLValidation: true, privateFilesUnavailable: true, publicChainBroadcasts: 0, errors };
  await writeFile(new URL('evidence/cloudflare-dashboard-local.json', root), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await mf?.dispose(); await peer.close(); await submitPeer.close(); await skippedPeer.close(); await idlePeer.close(); }
