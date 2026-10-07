import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startBridge } from '../bridge.mjs';
import { checkDashboard } from './dashboard-checks.mjs';

const bridge = process.env.CARDANO_SITE ? { url: process.env.CARDANO_SITE, close: async () => {} } : await startBridge({ port: 0, peerHost: process.env.PEER_HOST,
  peerPort: Number(process.env.PEER_PORT ?? 3001), networkMagic: Number(process.env.NETWORK_MAGIC ?? 2) });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [], events = [], sockets = [];
let observedTransaction, submissionTab = null;
const name = process.env.EVIDENCE_NAME ?? 'browser';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name');
page.on('websocket', socket => sockets.push(socket.url()));
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  const began = Date.now();
  await page.goto(bridge.url);
  if (process.env.CARDANO_RELAY) {
    await page.waitForFunction(() => !document.querySelector('#connect').disabled);
    await page.locator('#url').fill(process.env.CARDANO_RELAY);
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(requireTx => [...document.querySelectorAll('#events .type')].some(e => e.textContent === 'Block body')
    && (!requireTx || Number(document.querySelector('#txs').textContent) > 0),
    process.env.REQUIRE_TX === '1', { timeout: 120000 });
  const stats = await page.evaluate(() => ({ memory: document.querySelector('#memory').textContent,
    received: document.querySelector('#received').textContent, blocks: document.querySelector('#count').textContent,
    transactions: document.querySelector('#txs').textContent, slot: document.querySelector('#slot').textContent,
    state: document.querySelector('#state').textContent, relayURL: document.querySelector('#url').value,
    relayHost: document.querySelector('#relay-host').textContent, localStorageEntries: localStorage.length }));
  events.push(...await page.locator('#events li').allTextContents());
  assert.equal(stats.localStorageEntries, 0);
  assert(Number(stats.blocks) > 0);
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  const dashboard = process.env.CHECK_DASHBOARD === '1'
    ? await checkDashboard(page, new URL(`../evidence/${name}`, import.meta.url).pathname) : null;
  if (process.env.REQUIRE_TX === '1') assert(Number(stats.transactions) > 0, 'Expected transaction-bearing block');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('#state').filter({ hasText: /^Disconnected$/ }).waitFor();
  if (Number(stats.transactions) > 0) {
    await page.locator('#block-rows tr').filter({ hasNotText: 'Unavailable' }).filter({ has: page.locator('td:nth-child(3)', { hasText: /^[1-9]/ }) }).first().locator('button').click();
    const card = page.locator('.tx-card').first();
    await card.locator(':scope > summary').click();
    await card.locator('.output-address').first().waitFor();
    assert.match(await card.locator('.tx-overview').textContent(), /ADA in outputs.*inputs.*outputs.*Fee/);
    assert.match(await card.locator('.input-ref').first().textContent(), /^[0-9a-f]{64}#\d+$/);
    assert.match(await card.locator('.output-address').first().textContent(), /^addr/);
    const txId = await card.locator('.tx-id').textContent();
    await card.getByText('Raw transaction CBOR', { exact: true }).click();
    const cborHex = await card.locator('.raw-detail').last().locator('pre').textContent();
    assert.match(cborHex, /^[0-9a-f]+$/);
    observedTransaction = { id: txId, cborHex };
    await page.getByRole('button', { name: 'Close block' }).click();
    const search = page.getByRole('searchbox', { name: 'Search transactions' });
    await search.fill(txId);
    await search.press('Enter');
    assert.equal(await page.locator('.tx-highlight').getAttribute('data-tx-id'), txId);
    assert(await page.locator('.tx-highlight .output-address').first().isVisible());
    await page.screenshot({ path: new URL(`../evidence/${name}-block.png`, import.meta.url).pathname });
    await page.keyboard.press('Escape');
    await search.fill('no-matching-transaction');
    await search.press('Enter');
    await page.getByText('No matching transaction in the observed blocks.').waitFor();
    await search.fill('');
  }
  await page.screenshot({ path: new URL(`../evidence/${name}-desktop.png`, import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
  await page.screenshot({ path: new URL(`../evidence/${name}-mobile.png`, import.meta.url).pathname, fullPage: true });
  if (process.env.CHECK_SUBMISSION === '1') {
    assert(observedTransaction, 'A live transaction is needed for the local review check');
    const connections = sockets.length;
    await page.getByRole('link', { name: 'Submit transaction', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#app-tabs')?.hidden === false);
    assert.equal(new URL(page.url()).pathname, '/submit/');
    assert(await page.locator('#install').isHidden());
    await page.locator('#cbor').fill(observedTransaction.cborHex);
    await page.locator('#inspect').click();
    await page.waitForFunction(() => !document.querySelector('#ready').hidden || !document.querySelector('#error').hidden);
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert.equal(await page.locator('#tx-id').textContent(), observedTransaction.id);
    assert(await page.locator('#send').isEnabled());
    assert.equal(sockets.length, connections, 'Review does not open a relay connection');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Submission fits mobile');
    await page.screenshot({ path: new URL(`../evidence/${name}-submit-mobile.png`, import.meta.url).pathname, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.screenshot({ path: new URL(`../evidence/${name}-submit-desktop.png`, import.meta.url).pathname, fullPage: true });
    submissionTab = { reviewedTransaction: observedTransaction.id, relayConnectionsOpened: 0, transactionsSubmitted: 0 };
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { testedAt: new Date().toISOString(), browser: await browser.version(),
    secondsToBlock: (Date.now() - began) / 1000, stats, dashboard, submissionTab, events, errors };
  await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ errors, state: await page.locator('#state').textContent().catch(() => ''),
    events: await page.locator('#events li').allTextContents().catch(() => []) }));
  throw error;
} finally { await browser.close(); await bridge.close(); }
