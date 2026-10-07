import { submissionTarget } from './connection.mjs';

const workerURL = new URL('./worker.mjs', import.meta.url).href;
const policy = globalThis.trustedTypes?.createPolicy('cardano-submit-worker', {
  createScriptURL(value) {
    if (value !== workerURL) throw new Error('Unexpected worker URL');
    return value;
  },
});

export function submission({ cborHex, era, onEvent, onError }) {
  const worker = new Worker(policy?.createScriptURL(workerURL) ?? workerURL, { type: 'module' });
  let ready = false, started = false, closed = false;
  const close = () => { closed = true; worker.terminate(); };
  const fail = error => { if (!closed) { close(); onError(error); } };
  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data.type === 'error') {
      const error = new Error(data.error);
      if (typeof data.announced === 'boolean') error.delivery = data.bodySent ? 'sent' : data.announced ? 'unknown' : 'none';
      return fail(error);
    }
    if (data.type === 'review') ready = true;
    try { onEvent(data); } catch (error) { fail(error); }
    if (data.type === 'complete') close();
  };
  worker.onerror = event => fail(new Error(event.message));
  worker.postMessage({ type: 'prepare', cborHex, era });
  return {
    close,
    send({ url, networkMagic }) {
      if (closed || !ready || started) throw new Error('Review a transaction before submitting it.');
      const target = submissionTarget(url, networkMagic);
      if (target.startsWith('tcp:') && (globalThis.location?.protocol !== 'isolated-app:' || typeof globalThis.TCPSocket !== 'function'))
        throw new Error('Open the installed Cardano Submit app to connect directly to a relay.');
      started = true;
      worker.postMessage({ type: 'submit', url: target, networkMagic });
    },
  };
}
