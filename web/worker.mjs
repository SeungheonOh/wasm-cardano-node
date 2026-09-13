import makeFFI from '../dist/ffi.mjs';
import { WASI, File, OpenFile, ConsoleStdout } from '../dist/wasi/index.js';
import { MuxTransport, LIMIT } from './transport.mjs';

let running = false;
let nextEvent = 0;
const acknowledgements = new Map();
self.onmessage = async ({ data }) => {
  if (data.type === 'ack') {
    acknowledgements.get(data.id)?.();
    acknowledgements.delete(data.id);
    return;
  }
  if (data.type !== 'start' || running) return;
  running = true;
  let transport, socket;
  try {
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
    socket = new WebSocket(data.url);
    socket.binaryType = 'arraybuffer';
    transport = new MuxTransport(async bytes => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is closed');
      if (socket.bufferedAmount + bytes.length > LIMIT) throw new Error('WebSocket send buffer is full');
      socket.send(bytes);
    }, event => new Promise(resolve => {
      const id = ++nextEvent;
      acknowledgements.set(id, resolve);
      self.postMessage({ type: 'event', id, event, memoryBytes: exports.memory.buffer.byteLength,
                         receivedBytes: transport.receivedBytes });
    }), () => socket.close());
    globalThis.cardanoTransport = transport;
    socket.onmessage = event => {
      if (!(event.data instanceof ArrayBuffer)) return transport.close(new Error('Bridge sent non-binary data'));
      transport.feed(new Uint8Array(event.data));
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
      socket.onclose = () => { clearTimeout(timer); reject(new Error('WebSocket closed before opening')); };
    });
    socket.onclose = () => transport.close(new Error('Peer connection closed'));
    socket.onerror = () => transport.close(new Error('WebSocket connection failed'));
    await exports.cardanoStream(data.magic, BigInt(data.epochSlots ?? 21600), data.blocks !== false ? 1 : 0);
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message });
  } finally {
    transport?.close();
    socket?.close();
    self.close();
  }
};
