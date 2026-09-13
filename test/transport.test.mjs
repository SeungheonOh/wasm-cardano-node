import test from 'node:test';
import assert from 'node:assert/strict';
import { MuxTransport, frame, hex, LIMIT } from '../web/transport.mjs';

test('mux survives every split of a header and payload, then coalesced protocols', async () => {
  const a = frame(2, Uint8Array.of(1, 2, 3), true), b = frame(8, Uint8Array.of(4, 5), true);
  const bytes = Uint8Array.from([...a, ...b]);
  for (let split = 1; split < bytes.length; split++) {
    const mux = new MuxTransport(() => {});
    const keepalive = mux.receive(8);
    mux.feed(bytes.slice(0, split)); mux.feed(bytes.slice(split));
    assert.equal(await mux.receive(2), '010203');
    assert.equal(await keepalive, '0405');
    assert.equal(mux.queuedBytes, 0);
    assert.equal(mux.buffer.length, 0);
    mux.close();
  }
});

test('sends chunks with initiator direction and lossless segmentation', async () => {
  const sent = [], mux = new MuxTransport(bytes => sent.push(bytes));
  const bytes = new Uint8Array(70000).fill(0x5a);
  await mux.send(3, hex(bytes));
  assert.deepEqual(sent.map(b => new DataView(b.buffer).getUint16(4)), [3, 3]);
  assert.deepEqual(sent.map(b => new DataView(b.buffer).getUint16(6)), [65535, 4465]);
  assert.deepEqual(Uint8Array.from(sent.flatMap(b => [...b.subarray(8)])), bytes);
  mux.close();
});

test('rejects invalid direction, unknown protocol, empty frames and oversized buffers', async () => {
  for (const invalid of [frame(2, Uint8Array.of(1)), frame(42, Uint8Array.of(1), true),
    frame(2, new Uint8Array(), true), new Uint8Array(LIMIT + 1)]) {
    let disconnected = false;
    const mux = new MuxTransport(() => {}, () => {}, () => { disconnected = true; });
    const receive = mux.receive(0);
    mux.feed(invalid);
    await assert.rejects(receive);
    assert(disconnected);
    assert.equal(mux.queuedBytes, 0);
  }
});

test('closing releases pending readers, timers and retained packets', async () => {
  const mux = new MuxTransport(() => {});
  mux.feed(frame(2, Uint8Array.of(1), true));
  const reader = mux.receive(8), timer = mux.sleep(30000);
  mux.close(new Error('cancelled'));
  await assert.rejects(reader, /cancelled/); await assert.rejects(timer, /cancelled/);
  assert.equal(mux.queuedBytes, 0); assert.equal(mux.pending.size, 0); assert.equal(mux.timers.size, 0);
});

test('event callback backpressure is awaited', async () => {
  let ack, complete = false;
  const mux = new MuxTransport(() => {}, () => new Promise(resolve => { ack = resolve; }));
  const emission = mux.emit('{"type":"block"}').then(() => { complete = true; });
  await Promise.resolve(); assert.equal(complete, false);
  ack(); await emission; assert.equal(complete, true);
  mux.close();
});
