import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reactor } from './runtime.mjs';
import { MuxTransport, frame, unhex } from '../web/transport.mjs';
import { encode, decode } from './cbor.mjs';

const preview = JSON.parse(await readFile(new URL('./fixtures/preview.json', import.meta.url)));
const mainnet = JSON.parse(await readFile(new URL('./fixtures/mainnet.json', import.meta.url)));

async function scenario({ magic = 2, acceptedMagic = magic, blocks = true, endAtConnected = false,
  noBlocks = false, duplicateBlock = false, invalidChainMessage = false, tipRaces = 0, cycles = 1, fixture = preview } = {}) {
  const events = [], sent = [];
  let next = 0, intersections = 0, mux;
  const reply = (protocol, payload) => {
    const packet = frame(protocol, typeof payload === 'string' ? unhex(payload) : encode(payload), true);
    let offset = 0;
    for (const size of [1, 3, 2, 5, 32, packet.length]) {
      mux.feed(packet.subarray(offset, offset + size)); offset += size;
      if (offset >= packet.length) break;
    }
  };
  mux = new MuxTransport(bytes => {
    const protocol = new DataView(bytes.buffer).getUint16(4);
    const message = decode(bytes.subarray(8));
    sent.push({ protocol, message });
    if (protocol === 0) {
      assert.deepEqual([...message[1].keys()], [14, 15]);
      assert.deepEqual(message[1].get(15), [magic, true, 0, false]);
      reply(0, [1, 15, [acceptedMagic, true, 0, false]]);
    } else if (protocol === 8) reply(8, [1, message[1]]);
    else if (protocol === 2) {
      if (invalidChainMessage) { reply(2, [99]); return; }
      if (message[0] === 4) {
        if (!message[1].length) reply(2, fixture.messages.tip);
        else {
          intersections++;
          // Must use the exact advertised tip, never a genesis/history fallback.
          assert.deepEqual(message[1], [decode(unhex(fixture.messages.tip))[1][0]]);
          reply(2, intersections <= tipRaces ? fixture.messages.tip : fixture.messages.intersect);
        }
      } else {
        assert.deepEqual(message, [0]);
        reply(2, next++ % 2 === 1 ? fixture.messages.forward : fixture.messages.rollback);
      }
    } else if (protocol === 3) {
      assert.equal(message[0], 0);
      assert.deepEqual(message[1], message[2]);
      assert.equal(message[1][0], Number(fixture.point.slot));
      assert.equal(Buffer.from(message[1][1]).toString('hex'), fixture.point.hash);
      if (noBlocks) reply(3, [3]);
      else {
        reply(3, fixture.messages.batch[0]);
        if (duplicateBlock) {
          const data = fixture.messages.batch[1];
          assert(data.endsWith('8105'));
          reply(3, data.slice(0, -4) + data);
        } else reply(3, fixture.messages.batch[1]);
      }
    }
  }, event => {
    events.push(event);
    if ((endAtConnected && event.type === 'connected') ||
      events.filter(e => e.type === 'rollBackward').length === cycles + 1) mux.close(new Error('Scenario complete'));
  });
  const wasm = await reactor(mux);
  const timeout = setTimeout(() => mux.close(new Error('Scenario timeout')), 5000);
  let failure;
  try { await wasm.cardanoStream(magic, 21600n, blocks ? 1 : 0); }
  catch (error) { if (mux.failure?.message !== 'Scenario complete') failure = error; }
  finally { clearTimeout(timeout); mux.close(); }
  return { events, sent, failure, intersections, memoryBytes: wasm.memory.buffer.byteLength };
}

test('WASM handshake accepts network magic across the entire uint32 range', async () => {
  for (const magic of [0, 1, 2, 764824073, 2147483648, 4294967295]) {
    const result = await scenario({ magic, endAtConnected: true });
    assert.ifError(result.failure);
    assert.equal(result.events[0].networkMagic, magic);
  }
});

test('WASM rejects a different network and out-of-range magic', async () => {
  for (const acceptedMagic of [1, -1, 4294967296]) {
    const result = await scenario({ acceptedMagic });
    assert.match(result.failure.message, /Handshake failed/);
    assert.equal(result.events.length, 0);
  }
});

test('real Conway header/body decode, tip intersection and subsequent rollback', async () => {
  const result = await scenario();
  assert.ifError(result.failure);
  assert.deepEqual(result.events.filter(e => e.type !== 'keepAlive').map(e => e.type), ['connected', 'intersect', 'rollBackward', 'rollForward', 'block', 'rollBackward']);
  assert.deepEqual(result.events.find(e => e.type === 'block').point, preview.point);
  assert.equal(result.events.find(e => e.type === 'block').era, 'ConwayEra');
  assert.equal(result.sent.filter(e => e.protocol === 3).length, 1);
  assert(result.memoryBytes < 64 * 1024 * 1024);
});

test('header-only mode does not request block bodies', async () => {
  const result = await scenario({ blocks: false });
  assert.ifError(result.failure);
  assert(result.events.some(e => e.type === 'rollForward'));
  assert(!result.sent.some(e => e.protocol === 3));
  assert(!result.events.some(e => e.type === 'block'));
  const ping = result.events.find(e => e.type === 'keepAlive');
  assert(ping && Number.isFinite(ping.roundTripMs) && ping.roundTripMs >= 0, 'Measure a completed Ouroboros KeepAlive exchange');
});

test('Mainnet transaction details match independently decoded wire bodies', async () => {
  const result = await scenario({ magic: 764824073, fixture: mainnet });
  assert.ifError(result.failure);
  const transactions = result.events.find(event => event.type === 'block').transactions;
  assert.equal(transactions.length, 2);
  for (const [index, tx] of transactions.entries()) {
    const captured = mainnet.transactions[index];
    assert.equal(tx.id, captured.id);
    assert.equal(tx.cborHex, captured.cborHex);
    assert.equal(tx.sizeBytes, captured.cborHex.length / 2);
    const [body] = decode(unhex(captured.cborHex));
    const inputs = body.get(0).value ?? body.get(0);
    assert.deepEqual(tx.inputs, inputs.map(([id, index]) => ({ txId: Buffer.from(id).toString('hex'), index })));
    assert.equal(tx.feeLovelace, String(body.get(2)));
    assert.equal(tx.validity.untilSlot, String(body.get(3)));
    assert.deepEqual(tx.outputs.map(output => output.lovelace), body.get(1).map(output => String(output[1])));
    assert.equal(tx.outputLovelace, String(body.get(1).reduce((sum, output) => sum + BigInt(output[1]), 0n)));
    assert(tx.outputs.every(output => output.address.startsWith('addr1')));
    assert.equal(tx.scriptValidity, 'valid');
  }
  assert.match(transactions[0].metadataJson, /Minswap: Aggregator Cancel Order/);
  assert.equal(transactions[1].metadataJson, null);
});

test('unavailable block is explicit and allows the subsequent rollback', async () => {
  const result = await scenario({ noBlocks: true });
  assert.ifError(result.failure);
  assert.deepEqual(result.events.slice(-2).map(e => e.type), ['blockUnavailable', 'rollBackward']);
});

test('tip changes retry intersection without downloading history', async () => {
  const result = await scenario({ tipRaces: 2 });
  assert.ifError(result.failure);
  assert.equal(result.intersections, 3);
  const exhausted = await scenario({ tipRaces: 99 });
  assert.match(exhausted.failure.message, /ten intersection attempts/);
  assert.equal(exhausted.intersections, 10);
});

test('extra block in a single-block batch and invalid protocol transitions fail', async () => {
  const extra = await scenario({ duplicateBlock: true });
  assert.match(extra.failure.message, /extra or different block/);
  const invalid = await scenario({ invalidChainMessage: true });
  assert(invalid.failure, 'Reject a message that is invalid for the current protocol state');
  assert(!invalid.failure.message.includes('timeout'));
  assert.deepEqual(invalid.events.filter(e => e.type !== 'keepAlive').map(e => e.type), ['connected']);
});

test('250 forward/fetch/rollback cycles retain bounded WASM memory', async () => {
  const result = await scenario({ cycles: 250 });
  assert.ifError(result.failure);
  assert.equal(result.events.filter(e => e.type === 'block').length, 250);
  assert(result.memoryBytes < 64 * 1024 * 1024, `Linear memory grew to ${result.memoryBytes}`);
});
