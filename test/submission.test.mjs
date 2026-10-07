import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reactor } from './runtime.mjs';
import { MuxTransport, frame } from '../web/transport.mjs';
import { submissionPeer } from './submission-peer.mjs';
import { transactionInput, relayTarget } from '../submit/input.mjs';
import { decode } from './cbor.mjs';

const transactions = JSON.parse(await readFile(new URL('./fixtures/mainnet.json', import.meta.url))).transactions;

test('Submission input accepts binary, hex and signed envelopes without changing bytes', () => {
  const tx = transactions[0];
  for (const source of [tx.cborHex, `0x${tx.cborHex.toUpperCase().match(/../g).join(' ')}`, Buffer.from(tx.cborHex, 'hex'),
    JSON.stringify({ type: 'Tx ConwayEra', cborHex: tx.cborHex }),
    Buffer.from(JSON.stringify({ type: 'Tx ConwayEra', description: '送信', cborHex: tx.cborHex }))]) {
    const input = transactionInput(source);
    assert.equal(input.cborHex, tx.cborHex); assert.equal(input.era, 6);
  }
  assert.equal(transactionInput(JSON.stringify({ type: 'Tx BabbageEra', cborHex: '80' })).era, 5);
  for (const input of ['', '0', 'zz', 'aa'.repeat(65537), '{', '{"type":"TxBody ConwayEra","cborHex":"80"}', '{"cborHex":3}'])
    assert.throws(() => transactionInput(input));
  assert.throws(() => transactionInput(new Uint8Array(1024 * 1024 + 1)));
});

test('Submission accepts direct TCP targets only', () => {
  assert.equal(relayTarget('tcp://relay.example:3001', 764824073), 'tcp://relay.example:3001');
  assert.equal(relayTarget('tcp://[::1]:3001', 2), 'tcp://[::1]:3001');
  for (const url of ['ws://relay:3001', 'https://relay:3001', 'tcp://relay', 'tcp://relay:0', 'tcp://relay:65536',
    'tcp://user@relay:3001', 'tcp://relay:3001/path', 'tcp://relay:3001?query']) assert.throws(() => relayTarget(url, 2));
  for (const magic of [-1, 0x100000000, 1.5]) assert.throws(() => relayTarget('tcp://relay:3001', magic));
});

test('WASM inspects complete signed CBOR locally and rejects invalid or trailing bytes before connecting', async () => {
  let networkCalls = 0;
  const wasm = await reactor({ send: () => { networkCalls++; throw new Error('Unexpected network'); } });
  for (const tx of transactions) {
    const review = JSON.parse(await wasm.cardanoInspectTransaction(6, tx.cborHex));
    assert.equal(review.transaction.id, tx.id);
    assert.equal(review.transaction.cborHex, tx.cborHex);
    assert(review.keyWitnesses > 0);
  }
  for (const [era, input] of [[6, '80'], [6, ''], [6, 'zz'], [6, transactions[0].cborHex + '00'], [7, transactions[0].cborHex], [6, 'aa'.repeat(65537)]]) {
    await assert.rejects(wasm.cardanoInspectTransaction(era, input));
    await assert.rejects(wasm.cardanoSubmitTransaction(2, 21600n, era, input));
  }
  assert.equal(networkCalls, 0);
});

async function scenario(mode = 'send', failBodyWrite = false) {
  const events = [];
  let mux, bodyWritten = false;
  const peer = submissionPeer({ transaction: transactions[0], mode, reply(protocol, payload) {
    const packet = frame(protocol, payload, true);
    // Fragment the transport header and CBOR payload independently.
    for (const [start, end] of [[0, 3], [3, 9], [9, packet.length]]) if (end > start) mux.feed(packet.subarray(start, end));
  } });
  mux = new MuxTransport(async bytes => {
    const protocol = new DataView(bytes.buffer, bytes.byteOffset).getUint16(4);
    const body = protocol === 4 && decode(bytes.subarray(8))[0] === 3;
    if (body && failBodyWrite) throw new Error('Simulated write failure');
    peer.receive(protocol, bytes.subarray(8));
    await Promise.resolve();
    if (body) bodyWritten = true;
  }, event => {
    if (event.type === 'sent') assert(bodyWritten, 'Do not claim sending until the write resolves');
    events.push(event);
  }, () => {}, [0, 4, 8]);
  const wasm = await reactor(mux);
  const timer = setTimeout(() => mux.close(new Error('Scenario timed out')), 5000);
  let error;
  try { await wasm.cardanoSubmitTransaction(764824073, 21600n, 6, transactions[0].cborHex); }
  catch (failure) { error = failure; }
  finally { clearTimeout(timer); mux.close(); }
  return { peer, events: events.filter(event => event.type !== 'keepAlive'), error };
}

test('WASM TxSubmission2 delivers exact signed bytes and ID using only protocols 0/4/8', async () => {
  for (const mode of ['send', 'nonblocking']) {
    const result = await scenario(mode);
    assert.ifError(result.error);
    assert.equal(result.peer.delivered, transactions[0].cborHex);
    assert.deepEqual([...result.peer.protocols].sort(), [0, 4, 8]);
    assert.deepEqual(result.events.map(event => event.type), ['connected', 'announced', 'sent', 'finished']);
    assert.equal(result.events.at(-1).sent, true);
    assert.deepEqual(result.peer.records.at(-1).message, [4]);
  }
});

test('Acknowledgement without a body request never reports the transaction sent', async () => {
  const result = await scenario('not-requested');
  assert.ifError(result.error);
  assert.equal(result.peer.delivered, undefined);
  assert.deepEqual(result.events.map(event => event.type), ['connected', 'announced', 'finished']);
  assert.equal(result.events.at(-1).sent, false);
});

test('WASM rejects unknown, unannounced, repeated IDs and invalid acknowledgements', async () => {
  for (const mode of ['unknown', 'unannounced', 'duplicate', 'repeat', 'bad-ack']) {
    const result = await scenario(mode);
    assert.match(result.error?.message ?? '', /Invalid TxSubmission2 request/, mode);
    assert.equal(result.events.filter(event => event.type === 'sent').length, mode === 'repeat' ? 1 : 0);
    assert(!result.events.some(event => event.type === 'finished'));
  }
});

test('A failed transaction write never emits the sent milestone', async () => {
  const result = await scenario('send', true);
  assert.match(result.error?.message ?? '', /Simulated write failure/);
  assert(!result.events.some(event => event.type === 'sent'));
});
