import { loadReactor } from '../web/reactor.mjs';
import { MuxTransport } from '../web/transport.mjs';
import { openSocket } from '../web/socket.mjs';
import { transactionInput } from './input.mjs';
import { submissionTarget } from './connection.mjs';

let preparing = false, running = false, prepared, exports;
function readableError(error) {
  const message = error.message ?? String(error);
  if (message.startsWith('ExceededTimeLimit')) return message.includes('KeepAlive')
    ? 'The relay stopped responding to connection checks.'
    : 'The relay did not respond in time to complete the protocol exchange.';
  if (message.startsWith('DecoderFailure')) return 'The relay sent an invalid protocol response. The connection was closed.';
  return message;
}
self.onmessage = async ({ data }) => {
  if (data.type === 'prepare' && !preparing) {
    preparing = true;
    try {
      const input = transactionInput(data.cborHex, data.era);
      self.postMessage({ type: 'loading' });
      exports = await loadReactor();
      const review = JSON.parse(await exports.cardanoInspectTransaction(input.era, input.cborHex));
      prepared = input;
      self.postMessage({ type: 'review', ...review, memoryBytes: exports.memory.buffer.byteLength });
    } catch (error) { self.postMessage({ type: 'error', error: error.message }); self.close(); }
    return;
  }
  if (data.type !== 'submit' || !prepared || running) return;
  running = true;
  let socket, transport, timer, progressTimer, announced = false, bodySent = false;
  try {
    const url = submissionTarget(data.url, data.networkMagic);
    if (url.startsWith('tcp:') && (self.location.protocol !== 'isolated-app:' || typeof TCPSocket !== 'function'))
      throw new Error('Direct TCP requires the installed Cardano Submit app.');
    transport = new MuxTransport(bytes => socket.write(bytes), event => {
      if (event.type === 'announced') announced = true;
      if (event.type === 'sent') bodySent = true;
      self.postMessage({ type: 'event', event, memoryBytes: exports.memory.buffer.byteLength,
        sentBytes: transport.sentBytes, receivedBytes: transport.receivedBytes });
    }, () => socket?.close(), [0, 4, 8]);
    globalThis.cardanoTransport = transport;
    const started = performance.now();
    const progress = () => self.postMessage({ type: 'progress', elapsedSeconds: Math.floor((performance.now() - started) / 1000) });
    // Default node startup delay is 60 seconds, before any ID request. Keep the
    // upstream protocol limits and allow startup plus time for the exchange.
    timer = setTimeout(() => transport.close(new Error(bodySent
      ? 'Transaction bytes were sent, but the relay did not finish the exchange within 3 minutes. Acceptance is unconfirmed.'
      : announced ? 'The relay exchange did not finish within 3 minutes. Delivery may be unknown.'
        : 'The relay did not request a transaction ID within 3 minutes. No transaction body was sent.')), 180000);
    progress();
    progressTimer = setInterval(progress, 1000);
    self.postMessage({ type: 'connecting' });
    socket = await openSocket(url, bytes => transport.feed(bytes), error => transport.close(error));
    await exports.cardanoSubmitTransaction(data.networkMagic, 21600n, prepared.era, prepared.cborHex);
    self.postMessage({ type: 'complete' });
  } catch (error) { self.postMessage({ type: 'error', error: readableError(transport?.failure ?? error), bodySent, announced }); }
  finally {
    clearTimeout(timer);
    clearInterval(progressTimer);
    transport?.close(); socket?.close();
    prepared = null;
    self.close();
  }
};
