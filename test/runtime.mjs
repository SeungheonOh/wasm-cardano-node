import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import net from 'node:net';
import { MuxTransport } from '../web/transport.mjs';
import makeFFI from '../dist/ffi.mjs';

export async function reactor(transport) {
  const compiled = await WebAssembly.compile(await readFile(new URL('../dist/cardano-stream.wasm', import.meta.url)));
  const wasi = new WASI({ version: 'preview1', args: ['cardano-stream'], env: {}, preopens: {} });
  const exports = {};
  const instance = await WebAssembly.instantiate(compiled, { ghc_wasm_jsffi: makeFFI(exports), wasi_snapshot_preview1: wasi.wasiImport });
  Object.assign(exports, instance.exports);
  wasi.initialize(instance);
  exports.hs_init(0, 0);
  globalThis.cardanoTransport = transport;
  return exports;
}

export async function liveStream({ host = 'preview-node.play.dev.cardano.org', port = 3001, magic = 2,
  seconds = 90, blocks = true, onEvent = () => {}, onWire = () => {} } = {}) {
  const socket = new net.Socket();
  const transport = new MuxTransport(bytes => new Promise((resolve, reject) => {
    onWire('send', bytes);
    socket.write(bytes, error => error ? reject(error) : resolve());
  }), onEvent, () => socket.destroy());
  socket.on('data', bytes => { onWire('receive', bytes); transport.feed(bytes); });
  socket.on('error', error => transport.close(error));
  socket.on('close', () => transport.close(new Error('Peer closed')));
  const wasm = await reactor(transport);
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(port, host, resolve);
    socket.setTimeout(10000, () => { socket.destroy(new Error('Connect timeout')); });
  });
  socket.setTimeout(0);
  const timeout = setTimeout(() => transport.close(new Error('Test complete')), seconds * 1000);
  try { await wasm.cardanoStream(magic, 21600n, blocks ? 1 : 0); }
  catch (error) {
    if (transport.failure?.message !== 'Test complete') throw error;
  } finally { clearTimeout(timeout); transport.close(); }
  return { memoryBytes: wasm.memory.buffer.byteLength, receivedBytes: transport.receivedBytes, sentBytes: transport.sentBytes };
}
