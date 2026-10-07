import assert from 'node:assert/strict';

export async function checkDashboard(page, evidencePrefix) {
  await page.waitForFunction(() => Number(document.querySelector('#count').textContent) >= 3 &&
    Number(document.querySelector('#txs').textContent) > 0 && document.querySelector('#ping').textContent.includes('ms') &&
    !document.querySelector('#fetch-time').textContent.includes('—') &&
    !document.querySelector('#tps').textContent.includes('—') &&
    !document.querySelector('#block-interval').textContent.includes('—'), null, { timeout: 180000 });
  const values = await page.evaluate(() => Object.fromEntries(
    ['height', 'epoch', 'block-interval', 'density', 'ping', 'ping-mean', 'peer-lead', 'fetch-time', 'tps', 'memory', 'sent', 'received']
      .map(id => [id, document.getElementById(id).textContent])));
  for (const [key, value] of Object.entries(values)) assert(!value.includes('—'), `${key}: ${value}`);
  assert(Number(values['block-interval'].split(' ')[0]) > 0);
  assert.equal(await page.locator('#url').isDisabled(), true);
  assert.equal(await page.locator('#network').isDisabled(), true);
  assert(await page.locator('#block-rows tr').count() >= 3);
  const block = page.locator('#block-rows button').first();
  const hash = await block.getAttribute('data-hash'); await block.click();
  assert((await page.locator('#block-hash').textContent()).includes(hash));
  await page.getByRole('button', { name: 'Close block' }).click();
  await page.screenshot({ path: `${evidencePrefix}-tables.png`, fullPage: true });
  const viewport = page.viewportSize();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Dashboard fits ${width}px`);
  }
  await page.setViewportSize(viewport);
  return values;
}
