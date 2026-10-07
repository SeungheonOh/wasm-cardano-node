export const BRIDGE_LIMITS = Object.freeze({
  lifetimeMs: 600000, idleMs: 30000, bytesPerDirection: 8 * 1048576,
  maxFrameBytes: 65543, maxMessagesPerDirection: 4096, maxQueuedBytes: 131086,
});

// One connection owns all its state. No transaction decoding or storage here.
export function startBridge(ws: WebSocket, tcp: Socket, limits = BRIDGE_LIMITS) {
  ws.binaryType = 'arraybuffer';
  const reader = tcp.readable.getReader(), writer = tcp.writable.getWriter();
  let closed = false, uploaded = 0, downloaded = 0, incoming = 0, outgoing = 0, queued = 0;
  let pending = Promise.resolve();
  let idle: ReturnType<typeof setTimeout>;
  const lifetime = setTimeout(() => finish(1000, 'Relay session reached its 10-minute limit. Reconnect to continue the live feed.'), limits.lifetimeMs);
  function finish(code = 1000, reason = 'Relay connection closed') {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime); clearTimeout(idle);
    ws.removeEventListener('message', onMessage);
    try { ws.close(code, reason); } catch { /* Already closed. */ }
    void tcp.close().catch(() => {});
    void Promise.allSettled([reader.cancel(), writer.abort()]).then(() => {
      reader.releaseLock(); writer.releaseLock();
    });
  }
  function activity() {
    clearTimeout(idle);
    idle = setTimeout(() => finish(1000, 'Relay connection was idle for 30 seconds.'), limits.idleMs);
  }
  function onMessage(event: MessageEvent) {
    if (closed) return;
    if (!(event.data instanceof ArrayBuffer)) return finish(1003, 'Only binary Cardano protocol messages are accepted.');
    const bytes = event.data.byteLength;
    if (!bytes || bytes > limits.maxFrameBytes || ++incoming > limits.maxMessagesPerDirection
        || (uploaded += bytes) > limits.bytesPerDirection || queued + bytes > limits.maxQueuedBytes)
      return finish(1009, 'Relay session exceeded its data limit.');
    queued += bytes; activity();
    pending = pending.then(async () => {
      try { if (!closed) await writer.write(event.data); }
      finally { queued -= bytes; }
    }).catch(() => finish(1011, 'The relay connection failed.'));
  }
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => finish());
  ws.addEventListener('error', () => finish(1011, 'Browser connection failed.'));
  void tcp.closed.catch(() => finish(1011, 'The relay connection failed.'));
  activity();
  void (async () => {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) return finish();
      if ((downloaded += value.byteLength) > limits.bytesPerDirection || ++outgoing > limits.maxMessagesPerDirection)
        return finish(1009, 'Relay session exceeded its data limit.');
      // Workers WebSockets have no send backpressure API. Total session output
      // is capped, so even a stalled browser cannot accumulate unbounded data.
      if (!closed) { ws.send(value); activity(); }
    }
  })().catch(() => finish(1011, 'The relay connection failed.'));
  return finish;
}
