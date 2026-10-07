import { buildUI } from './build-ui.mjs';
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { BundleBuilder } from 'wbn';
import { SignedWebBundle, NodeCryptoSigningStrategy, WebBundleId } from 'wbn-sign';
import { iwaConfig } from '../iwa.mjs';

await buildUI();
const root = new URL('../', import.meta.url);
const submit = process.argv.includes('--submit');
const app = submit ? 'submit' : 'web';
const bundleName = submit ? 'cardano-submit' : 'cardano-live';
await mkdir(new URL('build/', root), { recursive: true });
await mkdir(new URL('dist/', root), { recursive: true });
// A local development identity, never packaged or committed.
const keyPath = new URL(`build/${submit ? 'submission' : 'iwa'}-development-key.pem`, root);
let privateKey;
try { privateKey = createPrivateKey(await readFile(keyPath)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  privateKey = generateKeyPairSync('ed25519').privateKey;
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
}
const origin = new WebBundleId(privateKey).serializeWithIsolatedWebAppOrigin();
const builder = new BundleBuilder('b2');
function add(url, type, bytes) {
  builder.addExchange(new URL(url, origin).href, 200, { 'Content-Type': type }, bytes);
}
const types = { html: 'text/html', mjs: 'text/javascript', js: 'text/javascript', css: 'text/css',
  svg: 'image/svg+xml', webmanifest: 'application/manifest+json', json: 'application/json', gz: 'application/gzip' };
async function addFile(file, url = `/${file}`) {
  add(url, types[file.split('.').pop()] ?? 'text/plain', await readFile(new URL(file, root)));
}
await addFile(`dist/${submit ? 'submit' : 'chain'}.html`, '/');
await addFile(`${app}/manifest.webmanifest`, '/.well-known/manifest.webmanifest');
await addFile(`${app}/manifest.webmanifest`, '/manifest.webmanifest');
if (!submit) add('/config.json', 'application/json', JSON.stringify(iwaConfig));
for (const name of await readdir(new URL(`${app}/`, root))) await addFile(`${app}/${name}`);
if (submit) for (const name of ['style.css', 'reactor.mjs', 'transport.mjs', 'socket.mjs', 'transactions.mjs', 'relays.mjs', 'relay-url.mjs']) await addFile(`web/${name}`);
await addFile(`dist/${submit ? 'submit' : 'chain'}-ui.mjs`);
for (const name of ['cardano-stream.wasm.gz', 'ffi.mjs', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'UI_LICENSES.txt']) {
  await addFile(`dist/${name}`);
}
for (const name of await readdir(new URL('dist/wasi/', root))) await addFile(`dist/wasi/${name}`);
const signed = await SignedWebBundle.fromWebBundle(builder.createBundle(), [new NodeCryptoSigningStrategy(privateKey)]);
const bytes = signed.getSignedWebBundleBytes();
await writeFile(new URL(`dist/${bundleName}.swbn`, root), bytes);
await writeFile(new URL(`dist/${submit ? 'submission-iwa' : 'iwa'}.json`, root), JSON.stringify({ origin, webBundleId: signed.getWebBundleId(), bytes: bytes.length }, null, 2) + '\n');
console.log(JSON.stringify({ bundle: new URL(`dist/${bundleName}.swbn`, root).pathname, origin, bytes: bytes.length }, null, 2));
