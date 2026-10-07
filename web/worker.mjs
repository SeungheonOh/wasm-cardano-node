import { loadReactor } from './reactor.mjs';
import { MuxTransport } from './transport.mjs';
import { openSocket } from './socket.mjs';

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
  let transport, socket, statsTimer;
  try {
    const exports = await loadReactor();
    transport = new MuxTransport(bytes => socket.write(bytes), event => new Promise(resolve => {
      const id = ++nextEvent;
      acknowledgements.set(id, resolve);
      self.postMessage({ type: 'event', id, event, memoryBytes: exports.memory.buffer.byteLength,
                         receivedBytes: transport.receivedBytes, sentBytes: transport.sentBytes });
    }), () => socket?.close());
    globalThis.cardanoTransport = transport;
    socket = await openSocket(data.url, bytes => transport.feed(bytes), error => transport.close(error));
    statsTimer = setInterval(() => self.postMessage({ type: 'stats',
      memoryBytes: exports.memory.buffer.byteLength, receivedBytes: transport.receivedBytes,
      sentBytes: transport.sentBytes }), 1000);
    await exports.cardanoStream(data.magic, BigInt(data.epochSlots ?? 21600), data.blocks !== false ? 1 : 0);
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message });
  } finally {
    clearInterval(statsTimer);
    transport?.close();
    socket?.close();
    self.close();
  }
};
