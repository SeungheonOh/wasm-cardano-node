import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startIWA } from '../iwa.mjs';
import { checkDashboard } from './dashboard-checks.mjs';

const root = new URL('../', import.meta.url);
const bundled = process.argv.includes('--bundle');
await mkdir(new URL('build/', root), { recursive: true });
await mkdir(new URL('evidence/', root), { recursive: true });
const profile = await mkdtemp(new URL('build/iwa-test-', root).pathname);
const server = bundled ? null : await startIWA({ port: 0 });
let context, serverClosed = false;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH ?? '/snap/bin/chromium', headless: true,
    args: ['--enable-features=IsolatedWebApps,IsolatedWebAppDevMode',
      ...(bundled ? [`--install-isolated-web-app-from-file=${new URL('dist/cardano-live.swbn', root).pathname}`] : [])],
    viewport: { width: 1280, height: 1100 },
  });
  const installer = context.pages()[0];
  await installer.goto('chrome://web-app-internals');
  let installResult = 'Signed bundle installed from local file';
  if (!bundled) {
    await installer.locator('#devInstallProxyUrl').fill(server.url);
    await installer.locator('#iwa-dev-install-proxy-button').click();
    await installer.waitForFunction(() => {
      const text = document.querySelector('web-app-internals-app').shadowRoot.querySelector('#iwa-dev-install-message').textContent.trim();
      return text && !text.endsWith('...');
    }, null, { timeout: 30000 });
    installResult = await installer.locator('#iwa-dev-install-message').textContent();
  }
  console.log(installResult);
  assert(!installResult.includes('failed'), installResult);
  let state, app;
  for (let attempt = 0; attempt < 30 && !app; attempt++) {
    await installer.reload();
    state = JSON.parse(await installer.locator('#json').textContent());
    app = state.InstalledWebApps.Details.find(app => app.start_url?.startsWith('isolated-app:'));
    if (!app) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(app, JSON.stringify(state.InstalledWebApps));
  const page = await context.newPage();
  const errors = [], webSockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('websocket', socket => webSockets.push(socket.url()));
  await page.goto(app.start_url);
  const capabilities = await page.evaluate(() => ({ origin: location.origin,
    isolated: crossOriginIsolated, tcpSocket: typeof TCPSocket,
    directSocketsAllowed: document.featurePolicy.allowsFeature('direct-sockets') }));
  console.log(JSON.stringify(capabilities));
  assert(capabilities.isolated && capabilities.tcpSocket === 'function' && capabilities.directSocketsAllowed);
  if (process.env.RELAY_URL) await page.locator('#url').fill(process.env.RELAY_URL);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#events')?.textContent.includes('Connected') ||
    !document.querySelector('#connect').disabled, null, { timeout: 30000 });
  assert((await page.locator('#events').textContent()).includes('Connected'), await page.locator('#state').textContent());
  const workerCapabilities = await page.workers()[0].evaluate(() => ({ tcpSocket: typeof TCPSocket, isolated: crossOriginIsolated }));
  assert.equal(workerCapabilities.tcpSocket, 'function');
  // All app assets are loaded. Close the ONLY server this test started before
  // waiting for another block, so it cannot forward the stream to the browser.
  const txCountBeforeShutdown = Number(await page.locator('#txs').textContent());
  if (server) { await server.close(); serverClosed = true; }
  console.log('No static server running; waiting for live transactions over browser TCP.');
  await page.waitForFunction(before => Number(document.querySelector('#txs').textContent) > before,
    txCountBeforeShutdown, { timeout: 120000 });
  const name = bundled ? 'iwa-bundle' : 'iwa';
  const dashboard = await checkDashboard(page, new URL(`evidence/${name}`, root).pathname);
  const stats = await page.evaluate(() => ({ memory: document.querySelector('#memory').textContent,
    received: document.querySelector('#received').textContent, slot: document.querySelector('#slot').textContent,
    transactions: Number(document.querySelector('#txs').textContent), blocks: Number(document.querySelector('#count').textContent) }));
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('#block-rows tr').filter({ has: page.locator('td:nth-child(3)', { hasText: /^[1-9]/ }) }).first().locator('button').click();
  await page.locator('.tx-card > summary').first().click();
  await page.locator('.output-address').first().waitFor();
  await page.screenshot({ path: new URL(`evidence/${name}-desktop.png`, root).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL(`evidence/${name}-mobile.png`, root).pathname, fullPage: true });
  assert.equal(webSockets.length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { testedAt: new Date().toISOString(), browser: context.browser().version(),
    mode: bundled ? 'signed-bundle' : 'development', relay: await page.locator('#url').inputValue(),
    installResult, capabilities, workerCapabilities, noStaticServerDuringStreaming: true,
    txCountBeforeShutdown, stats, dashboard, webSockets, staticRequests: server?.requests ?? [], errors };
  await writeFile(new URL(`evidence/${name}.json`, root), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  if (server && !serverClosed) await server.close();
  await rm(profile, { recursive: true, force: true });
}
