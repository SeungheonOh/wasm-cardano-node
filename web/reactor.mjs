import makeFFI from '../dist/ffi.mjs';
import { WASI, File, OpenFile, ConsoleStdout } from '../dist/wasi/index.js';

export async function loadReactor() {
  const response = await fetch(new URL('../dist/cardano-stream.wasm.gz', import.meta.url));
  if (!response.ok) throw new Error('Build the WASM artifact first');
  const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const compiled = await WebAssembly.compile(bytes);
  const wasi = new WASI(['cardano-stream'], [], [
    new OpenFile(new File(new Uint8Array())),
    ConsoleStdout.lineBuffered(console.log), ConsoleStdout.lineBuffered(console.error),
  ]);
  const exports = {};
  const instance = await WebAssembly.instantiate(compiled, {
    ghc_wasm_jsffi: makeFFI(exports), wasi_snapshot_preview1: wasi.wasiImport,
  });
  Object.assign(exports, instance.exports);
  wasi.initialize(instance);
  exports.hs_init(0, 0);
  return exports;
}
