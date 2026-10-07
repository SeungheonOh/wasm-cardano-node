const workerURL = new URL('./worker.mjs', import.meta.url).href;
// IWAs enforce Trusted Types. Only this bundled worker is an allowed script URL.
const workerPolicy = globalThis.trustedTypes?.createPolicy('cardano-worker', {
  createScriptURL(value) {
    if (value !== workerURL) throw new Error('Unexpected worker URL');
    return value;
  },
});

/** Connect to a byte bridge, or directly to tcp://host:port inside an IWA. */
export function connect({ url, networkMagic = 2, epochSlots = 21600, blocks = true, onEvent, onStats, onError = console.error }) {
  if (!Number.isInteger(networkMagic) || networkMagic < 0 || networkMagic > 0xffffffff)
    throw new Error('networkMagic must be a uint32');
  if (!Number.isSafeInteger(epochSlots) || epochSlots <= 0) throw new Error('epochSlots must be a positive integer');
  if (typeof onEvent !== 'function') throw new Error('onEvent is required');
  const target = new URL(url);
  if (!['ws:', 'wss:', 'tcp:'].includes(target.protocol)) throw new Error('Expected a ws://, wss:// or tcp:// URL');
  if (target.protocol === 'tcp:') {
    if (!target.hostname || !target.port || Number(target.port) < 1 || Number(target.port) > 65535 ||
      target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname))
      throw new Error('Expected tcp://host:port without a path or credentials');
    if (location.protocol !== 'isolated-app:') throw new Error('Open the installed Isolated Web App to connect directly over TCP');
  }
  const worker = new Worker(workerPolicy?.createScriptURL(workerURL) ?? workerURL, { type: 'module' });
  let closed = false;
  const close = () => { closed = true; worker.terminate(); };
  worker.onmessage = async ({ data }) => {
    if (closed) return;
    if (data.type === 'event') {
      try {
        await onEvent(data.event, { memoryBytes: data.memoryBytes, receivedBytes: data.receivedBytes, sentBytes: data.sentBytes });
        if (!closed) worker.postMessage({ type: 'ack', id: data.id });
      }
      catch (error) { close(); onError(error); }
    } else if (data.type === 'stats') {
      try { await onStats?.({ memoryBytes: data.memoryBytes, receivedBytes: data.receivedBytes, sentBytes: data.sentBytes }); }
      catch (error) { close(); onError(error); }
    } else if (data.type === 'error') { close(); onError(new Error(data.error)); }
  };
  worker.onerror = event => { close(); onError(new Error(event.message)); };
  worker.postMessage({ type: 'start', url: target.href, magic: networkMagic, epochSlots, blocks });
  return { close };
}
