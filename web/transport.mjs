// Ouroboros mux framing only. CBOR, negotiation and mini-protocol state live in WASM.
export const LIMIT = 2 * 1024 * 1024;
const protocols = new Set([0, 2, 3, 8]);
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const unhex = text => {
  if (text.length % 2 || !/^[0-9a-f]*$/i.test(text)) throw new Error('Invalid byte encoding');
  return Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));
};

export function frame(protocol, payload, responder = false) {
  if (payload.length > 65535) throw new Error('Mux segment exceeds 65535 bytes');
  const result = new Uint8Array(8 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, Math.trunc(performance.now() * 1000) >>> 0);
  view.setUint16(4, protocol | (responder ? 0x8000 : 0));
  view.setUint16(6, payload.length);
  result.set(payload, 8);
  return result;
}

export class MuxTransport {
  constructor(write, onEvent = () => {}, disconnect = () => {}) {
    this.write = write;
    this.onEvent = onEvent;
    this.disconnect = disconnect;
    this.pending = new Map();
    this.queues = new Map([...protocols].map(p => [p, []]));
    this.buffer = new Uint8Array();
    this.queuedBytes = 0;
    this.failure = null;
    this.timers = new Map();
    this.receivedBytes = 0;
    this.sentBytes = 0;
  }
  feed(chunk) {
    if (this.failure) return;
    try {
      if (chunk.byteLength + this.buffer.length + this.queuedBytes > LIMIT)
        throw new Error('Peer exceeded the receive buffer limit');
      this.receivedBytes += chunk.byteLength;
      const bytes = new Uint8Array(this.buffer.length + chunk.byteLength);
      bytes.set(this.buffer); bytes.set(chunk, this.buffer.length);
      let offset = 0;
      while (bytes.length - offset >= 8) {
        const view = new DataView(bytes.buffer, offset);
        const id = view.getUint16(4), protocol = id & 0x7fff, length = view.getUint16(6);
        if (!(id & 0x8000) || !protocols.has(protocol)) throw new Error(`Unexpected mux protocol/direction ${id}`);
        if (!length) throw new Error('Empty mux segment');
        if (bytes.length - offset < 8 + length) break;
        const payload = bytes.slice(offset + 8, offset + 8 + length);
        offset += 8 + length;
        const waiter = this.pending.get(protocol);
        if (waiter) {
          this.pending.delete(protocol);
          waiter.resolve(hex(payload));
        } else {
          this.queues.get(protocol).push(payload);
          this.queuedBytes += payload.length;
        }
      }
      this.buffer = bytes.slice(offset);
    } catch (error) { this.close(error); }
  }
  receive(protocol) {
    if (this.failure) return Promise.reject(this.failure);
    if (!protocols.has(protocol) || this.pending.has(protocol))
      return Promise.reject(new Error('Invalid concurrent receive'));
    const queue = this.queues.get(protocol);
    if (queue.length) {
      const bytes = queue.shift();
      this.queuedBytes -= bytes.length;
      return Promise.resolve(hex(bytes));
    }
    return new Promise((resolve, reject) => this.pending.set(protocol, { resolve, reject }));
  }
  async send(protocol, encoded) {
    if (this.failure) throw this.failure;
    if (!protocols.has(protocol)) throw new Error('Unknown outgoing protocol');
    const bytes = unhex(encoded);
    for (let offset = 0; offset < bytes.length; offset += 65535) {
      const segment = frame(protocol, bytes.subarray(offset, offset + 65535));
      await this.write(segment);
      this.sentBytes += segment.length;
    }
  }
  async emit(encoded) {
    if (this.failure) throw this.failure;
    await this.onEvent(JSON.parse(encoded));
  }
  sleep(ms) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms);
      this.timers.set(timer, reject);
    });
  }
  close(error = new Error('Disconnected')) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const [timer, reject] of this.timers) { clearTimeout(timer); reject(error); }
    this.timers.clear();
    for (const queue of this.queues.values()) queue.length = 0;
    this.queuedBytes = 0;
    this.buffer = new Uint8Array();
    this.disconnect();
  }
}
