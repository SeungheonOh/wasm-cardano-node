import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startBridge, BRIDGE_LIMITS } from '../cloudflare/bridge.ts';
import { hostedTarget, submissionTarget } from '../submit/connection.mjs';
import { parseRelayURL, bridgeTarget, relayBridgeURL } from '../web/relay-url.mjs';

test('bridge accepts general TCP URLs, IPv4, IPv6 and arbitrary ports without relay tags', () => {
  assert.deepEqual(parseRelayURL('tcp://CUSTOM.example:43210/'), { url: 'tcp://custom.example:43210', host: 'custom.example', port: 43210 });
  assert.deepEqual(parseRelayURL('tcp://195.49.96.164:3001'), { url: 'tcp://195.49.96.164:3001', host: '195.49.96.164', port: 3001 });
  assert.deepEqual(parseRelayURL('tcp://[2a01:2a8:a23d:16::17]:1234'), { url: 'tcp://[2a01:2a8:a23d:16::17]:1234', host: '2a01:2a8:a23d:16::17', port: 1234 });
  for (const value of ['https://node.example:3001', 'node.example:3001', 'mainnet-iog', 'tcp://node.example',
    'tcp://node.example:0', 'tcp://node.example:65536', 'tcp://user:pass@node.example:3001', 'tcp://@node.example:3001',
    'tcp://node.example:3001/path', 'tcp://node.example:3001?x=1', 'tcp://node.example:3001#x',
    'tcp://node.ex\nample:3001', '\u0000tcp://node.example:3001']) assert.throws(() => parseRelayURL(value), value);
  const outer = relayBridgeURL('tcp://custom.example:43210', 'https://cardano.isotopy.xyz');
  assert.equal(new URL(outer).searchParams.get('url'), 'tcp://custom.example:43210');
  assert.equal(bridgeTarget(new URL(outer)).port, 43210);
  assert.equal(bridgeTarget(new URL('https://cardano.isotopy.xyz/ouroboros?url=tcp://custom.example:43210')).host, 'custom.example');
  for (const suffix of ['&url=tcp://other.example:3001', '&host=other.example']) assert.throws(() => bridgeTarget(new URL(outer + suffix)));
  assert.throws(() => bridgeTarget(new URL('https://cardano.isotopy.xyz/ouroboros?relay=mainnet-iog')));
});

test('hosted submission uses same-origin bridge URLs and validates the network magic', () => {
  const origin = 'https://cardano.isotopy.xyz';
  const url = hostedTarget('tcp://backbone.cardano.iog.io:3001', 764824073, origin);
  assert.equal(new URL(url).searchParams.get('url'), 'tcp://backbone.cardano.iog.io:3001');
  assert.equal(submissionTarget(url, 764824073, origin), url);
  assert.equal(new URL(hostedTarget('tcp://custom.example:43210', 764824073, origin)).searchParams.get('url'), 'tcp://custom.example:43210');
  assert.throws(() => hostedTarget('tcp://custom.example:43210', -1, origin));
  for (const bad of [url.replace('wss:', 'ws:'), url.replace('cardano.isotopy.xyz', 'attacker.example'),
    url + '&host=127.0.0.1', url + '&url=tcp://other.example:3001', url + '#foo'])
    assert.throws(() => submissionTarget(bad, 764824073, origin));
  assert.equal(submissionTarget('tcp://127.0.0.1:3001', 2, 'isolated-app://app'), 'tcp://127.0.0.1:3001');
});

function fixture(limits = BRIDGE_LIMITS, stalled = false) {
  class WS extends EventTarget {
    sent = []; code; reason;
    send(bytes) { this.sent.push(Uint8Array.from(bytes)); }
    close(code, reason) { this.code = code; this.reason = reason; }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  }
  const ws = new WS(), writes = [];
  let control, closes = 0, release;
  const tcp = {
    readable: new ReadableStream({ start(c) { control = c; } }),
    writable: new WritableStream({ write(bytes) { writes.push(new Uint8Array(bytes)); if (stalled) return new Promise(resolve => { release = resolve; }); } }),
    closed: new Promise(() => {}), close: async () => { closes++; release?.(); },
  };
  const stop = startBridge(ws, tcp, limits);
  return { ws, writes, control, stop, get closes() { return closes; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('byte bridge preserves ordered bytes in both directions and closes TCP on browser close', async () => {
  const f = fixture();
  try {
    f.ws.message(Uint8Array.of(0, 1, 2).buffer); f.ws.message(Uint8Array.of(255, 4).buffer);
    f.control.enqueue(Uint8Array.of(6, 8, 0, 254));
    await tick();
    assert.deepEqual(f.writes.map(x => [...x]), [[0, 1, 2], [255, 4]]);
    assert.deepEqual(f.ws.sent.map(x => [...x]), [[6, 8, 0, 254]]);
    f.ws.dispatchEvent(new Event('close')); await tick();
    assert.equal(f.closes, 1);
  } finally { f.stop(); }
});

test('bridge rejects text, oversized frames, exhausted byte/message budgets and stalled writes', async () => {
  for (const [limits, messages, code, stalled] of [
    [BRIDGE_LIMITS, ['text'], 1003],
    [BRIDGE_LIMITS, [new ArrayBuffer(BRIDGE_LIMITS.maxFrameBytes + 1)], 1009],
    [{ ...BRIDGE_LIMITS, bytesPerDirection: 3 }, [new ArrayBuffer(2), new ArrayBuffer(2)], 1009],
    [{ ...BRIDGE_LIMITS, maxMessagesPerDirection: 1 }, [new ArrayBuffer(1), new ArrayBuffer(1)], 1009],
    [{ ...BRIDGE_LIMITS, maxQueuedBytes: 3 }, [new ArrayBuffer(2), new ArrayBuffer(2)], 1009, true],
  ]) {
    const f = fixture(limits, stalled);
    try {
      messages.forEach(message => f.ws.message(message)); await tick();
      assert.equal(f.ws.code, code); assert.equal(f.closes, 1);
      assert.equal(f.writes.length, 0, 'No queued bytes are sent after rejection');
    } finally { f.stop(); }
  }
});

test('bridge bounds output to slow clients and expires idle/long sessions', async () => {
  const f = fixture({ ...BRIDGE_LIMITS, bytesPerDirection: 3 });
  try {
    f.control.enqueue(Uint8Array.of(1, 2, 3, 4)); await tick();
    assert.equal(f.ws.code, 1009); assert.deepEqual(f.ws.sent, []);
  } finally { f.stop(); }
  for (const field of ['lifetimeMs', 'idleMs']) {
    const f = fixture({ ...BRIDGE_LIMITS, [field]: 1 });
    try { await tick(); assert.equal(f.closes, 1); assert.equal(f.ws.code, 1000); }
    finally { f.stop(); }
  }
});
