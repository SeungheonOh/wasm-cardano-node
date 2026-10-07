import { LIMIT } from './transport.mjs';

// Both transports carry the same Ouroboros mux bytes. TCP is supplied by Chrome
// inside an installed IWA; it never falls back to a proxy.
export async function openSocket(url, onBytes, onError) {
  const target = new URL(url);
  if (target.protocol === 'tcp:') return openTCP(target, onBytes, onError);
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let closed = false;
  const close = () => { closed = true; socket.close(); };
  socket.onmessage = ({ data }) => {
    if (!(data instanceof ArrayBuffer)) return onError(new Error('Bridge sent non-binary data'));
    onBytes(new Uint8Array(data));
  };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('WebSocket connection timed out')), 10000);
      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error('WebSocket connection failed'));
      socket.onclose = () => finish(new Error('WebSocket closed before opening'));
    });
  } catch (error) { close(); throw error; }
  socket.onclose = event => { if (!closed) onError(new Error(event.reason || 'Peer connection closed')); };
  socket.onerror = () => { if (!closed) onError(new Error('WebSocket connection failed')); };
  return {
    async write(bytes) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is closed');
      if (socket.bufferedAmount + bytes.length > LIMIT) throw new Error('WebSocket send buffer is full');
      socket.send(bytes);
    },
    close,
  };
}

async function openTCP(target, onBytes, onError) {
  if (typeof TCPSocket !== 'function') throw new Error('Direct TCP requires an installed Isolated Web App with Direct Sockets enabled');
  const socket = new TCPSocket(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port), { noDelay: true });
  let reader, writer, closed = false, queuedBytes = 0, timer;
  const close = () => {
    if (closed) return;
    closed = true;
    void Promise.allSettled([reader?.cancel(), writer?.abort()]).then(() => {
      reader?.releaseLock(); writer?.releaseLock();
      return socket.close();
    }).catch(() => {});
  };
  socket.closed.then(() => {
    if (!closed) onError(new Error('Peer connection closed'));
  }, error => { if (!closed) onError(error); });
  try {
    const streams = await Promise.race([socket.opened, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TCP connection timed out')), 10000);
    })]);
    reader = streams.readable.getReader();
    writer = streams.writable.getWriter();
  } catch (error) { close(); throw error; }
  finally { clearTimeout(timer); }
  void (async () => {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) { if (!closed) onError(new Error('Peer connection closed')); break; }
      onBytes(value);
    }
  })().catch(error => { if (!closed) onError(error); });
  return {
    async write(bytes) {
      if (closed) throw new Error('TCP socket is closed');
      if (queuedBytes + bytes.byteLength > LIMIT) throw new Error('TCP send buffer is full');
      queuedBytes += bytes.byteLength;
      try { await writer.write(bytes); }
      finally { queuedBytes -= bytes.byteLength; }
    },
    close,
  };
}
