/** Connect to an Ouroboros byte bridge. close() destroys the worker and its WASM heap. */
export function connect({ url, networkMagic = 2, epochSlots = 21600, blocks = true, onEvent, onError = console.error }) {
  if (!Number.isInteger(networkMagic) || networkMagic < 0 || networkMagic > 0xffffffff)
    throw new Error('networkMagic must be a uint32');
  if (!Number.isSafeInteger(epochSlots) || epochSlots <= 0) throw new Error('epochSlots must be a positive integer');
  if (typeof onEvent !== 'function') throw new Error('onEvent is required');
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error('Expected a ws:// or wss:// byte bridge URL');
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  let closed = false;
  const close = () => { closed = true; worker.terminate(); };
  worker.onmessage = async ({ data }) => {
    if (closed) return;
    if (data.type === 'event') {
      try {
        await onEvent(data.event, { memoryBytes: data.memoryBytes, receivedBytes: data.receivedBytes });
        if (!closed) worker.postMessage({ type: 'ack', id: data.id });
      }
      catch (error) { close(); onError(error); }
    } else if (data.type === 'error') { close(); onError(new Error(data.error)); }
  };
  worker.onerror = event => { close(); onError(new Error(event.message)); };
  worker.postMessage({ type: 'start', url: target.href, magic: networkMagic, epochSlots, blocks });
  return { close };
}
