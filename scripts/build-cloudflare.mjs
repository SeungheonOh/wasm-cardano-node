import { buildUI } from './build-ui.mjs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { RELAYS } from '../web/relays.mjs';
await buildUI();
const root = new URL('../', import.meta.url);
const output = new URL('build/cloudflare-assets/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function copy(path, destination = path) {
  const source = new URL(path, root), target = new URL(destination, output);
  if ((await stat(source)).size > 25 * 1024 * 1024) throw new Error(`Static asset exceeds 25 MiB: ${path}`);
  await mkdir(new URL('./', target), { recursive: true });
  await cp(source, target);
}
// Explicit public assets only. Never publish build trees, evidence, keys, or
// the uncompressed 70 MB reactor. The browser decompresses the .gz itself.
await copy('dist/chain-hosted.html', 'index.html');
await copy('web/manifest.webmanifest', 'manifest.webmanifest');
for (const name of await readdir(new URL('web/', root))) {
  if (/\.(mjs|css|svg|webmanifest)$/.test(name)) await copy(`web/${name}`);
}
for (const name of await readdir(new URL('submit/', root))) {
  if (/\.(mjs|css|svg)$/.test(name)) await copy(`submit/${name}`);
}
await copy('dist/submit-hosted.html', 'submit/index.html');
for (const name of ['chain-ui.mjs', 'submit-ui.mjs', 'cardano-stream.wasm.gz', 'ffi.mjs', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'UI_LICENSES.txt']) await copy(`dist/${name}`);
for (const name of await readdir(new URL('dist/wasi/', root))) if (name.endsWith('.js') || name.startsWith('LICENSE')) await copy(`dist/wasi/${name}`);
const peer = RELAYS[0];
await writeFile(new URL('config.json', output), JSON.stringify({ app: 'cardano-live', transport: 'websocket',
  peerHost: peer.host, peerPort: peer.port, networkMagic: peer.networkMagic, bridgePath: '/ouroboros', submission: true, relays: RELAYS }));
await writeFile(new URL('404.html', output), '<!doctype html><title>Not found</title><a href="/">Open Cardano Live</a>');
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss://cardano.isotopy.xyz; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types cardano-worker cardano-submit-worker";
await writeFile(new URL('_headers', output), `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cache-Control: public, max-age=0, must-revalidate
/dist/cardano-stream.wasm.gz
  Content-Type: application/gzip
  ! Content-Encoding
`);
console.log('Prepared chain and submission assets (compressed browser WASM, no keys or chain data).');
