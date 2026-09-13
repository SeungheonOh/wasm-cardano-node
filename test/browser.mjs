import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startBridge } from '../bridge.mjs';

const bridge = await startBridge({ port: 0, peerHost: process.env.PEER_HOST,
  peerPort: Number(process.env.PEER_PORT ?? 3001), networkMagic: Number(process.env.NETWORK_MAGIC ?? 2) });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [], events = [];
const name = process.env.EVIDENCE_NAME ?? 'browser';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name');
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  const began = Date.now();
  await page.goto(bridge.url);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(requireTx => [...document.querySelectorAll('#events .type')].some(e => e.textContent === 'Block body')
    && (!requireTx || Number(document.querySelector('#txs').textContent) > 0),
    process.env.REQUIRE_TX === '1', { timeout: 120000 });
  const stats = await page.evaluate(() => ({ memory: document.querySelector('#memory').textContent,
    received: document.querySelector('#received').textContent, blocks: document.querySelector('#count').textContent,
    transactions: document.querySelector('#txs').textContent, slot: document.querySelector('#slot').textContent,
    state: document.querySelector('#state').textContent, localStorageEntries: localStorage.length }));
  events.push(...await page.locator('#events li').allTextContents());
  assert.equal(stats.localStorageEntries, 0);
  assert(Number(stats.blocks) > 0);
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  if (process.env.REQUIRE_TX === '1') assert(Number(stats.transactions) > 0, 'Expected transaction-bearing block');
  await page.screenshot({ path: new URL(`../evidence/${name}-desktop.png`, import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
  await page.screenshot({ path: new URL(`../evidence/${name}-mobile.png`, import.meta.url).pathname, fullPage: true });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByText('Disconnected', { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { testedAt: new Date().toISOString(), browser: await browser.version(),
    secondsToBlock: (Date.now() - began) / 1000, stats, events, errors };
  await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await bridge.close(); }
