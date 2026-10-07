import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const config = JSON.parse((await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN in your environment.');
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/settings`, {
  headers: { Authorization: `Bearer ${token}` },
});
const result = await response.json();
if (!response.ok || !result.success || result.result?.free_tier !== true)
  throw new Error('Deployment stopped: could not verify Workers Free. A paid account has no zero-spend request cap.');
console.log('Verified Workers Free: account-wide 100,000 requests/day and 10 ms CPU; no paid upgrade.');
const deployed = spawnSync(new URL('../node_modules/.bin/wrangler', import.meta.url).pathname,
  ['deploy'], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (deployed.error) throw deployed.error;
process.exit(deployed.status ?? 1);
