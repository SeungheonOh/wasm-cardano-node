import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainMetrics, slotClock, MAX_BLOCKS } from '../web/metrics.mjs';

const point = (slot, hash = String(slot)) => ({ slot: String(slot), hash });
const header = (slot, height, hash) => ({ type: 'rollForward', point: point(slot, hash), blockNo: String(height),
  tip: { point: point(slot, hash), blockNo: String(height) } });
const tx = overrides => ({ sizeBytes: 200, feeLovelace: '170001', outputLovelace: '9007199254740993123',
  collateralInputs: [], mint: [], outputs: [{ assets: [] }], metadataJson: null, ...overrides });
const body = (slot, transactions = [], hash) => ({ type: 'block', point: point(slot, hash), era: 'ConwayEra', transactions });
const start = (bodies = true) => {
  const m = new ChainMetrics(); m.reset(764824073, 0, 0, bodies);
  m.ingest({ type: 'connected', version: 'NodeToNodeVersion_15' }, 0);
  m.ingest({ type: 'intersect', point: point(4492800), tip: { point: point(4492800), blockNo: '100' } }, 0);
  return m;
};

test('epoch and wall clock anchors handle Shelley offsets and epoch boundaries', () => {
  assert.deepEqual(slotClock(764824073, '4492800'), { epoch: 208, slotInEpoch: 0, epochLength: 432000, time: 1596059091000 });
  assert.equal(slotClock(764824073, 4492800 + 432000).epoch, 209);
  assert.equal(slotClock(764824073, 4492800 + 431999).slotInEpoch, 431999);
  assert.deepEqual(slotClock(1, 86400), { epoch: 4, slotInEpoch: 0, epochLength: 432000, time: 1655769600000 });
  assert.equal(slotClock(2, 86400).epoch, 1);
  assert.equal(slotClock(2, 0).time, 1666656000000);
  assert.equal(slotClock(42, 100), null);
  assert.equal(slotClock(764824073, null), null);
  assert.equal(slotClock(764824073, 1000), null);
});

test('intervals use consecutive chain slots, not bursty receive times; totals keep exact integers', () => {
  const m = start();
  m.ingest(header(4492820, 101), 1000);
  m.ingest(body(4492820, [tx({ collateralInputs: [{}], metadataJson: '{}', mint: [{}] })]), 1040);
  m.ingest(header(4492850, 102), 1001);
  m.ingest(body(4492850, [tx({})]), 1070);
  const s = m.snapshot(20000, 1596059145000);
  assert.equal(s.averageInterval, 30); assert.equal(s.density, 100 / 30);
  assert.equal(s.meanFetch, 54.5); assert.equal(s.totals.fees, 340002n);
  assert.equal(s.totals.outputs, 18014398509481986246n);
  assert.equal(s.totals.collateral, 1); assert.equal(s.totals.assets, 1); assert.equal(s.totals.metadata, 1);
  assert.equal(s.tps, 0.1); assert.equal(s.peerLead, '0'); assert.equal(s.tipAge, 4);
  m.ingest(header(4492880, 104), 2000);
  assert.equal(m.snapshot(20000).intervals.length, 1, 'A gap in block heights cannot produce a consecutive interval');
});

test('rollback removes orphaned samples and replacements count once per observation', () => {
  const m = start();
  m.ingest({ type: 'rollBackward', point: point(4492800), tip: { point: point(4492800), blockNo: '100' } }, 10);
  assert.equal(m.rollbackNotice, '', 'Initial positioning is counted without a fork warning');
  for (let i = 1; i <= 3; i++) { m.ingest(header(4492800 + i * 20, 100 + i), i * 1000); m.ingest(body(4492800 + i * 20, [tx({})]), i * 1000 + 50); }
  m.ingest({ type: 'rollBackward', point: point(4492820), tip: { point: point(4492820), blockNo: '101' } }, 4000);
  let s = m.snapshot(20000);
  assert.equal(m.deepestRollback, 2); assert.equal(m.blocks.length, 1); assert.equal(s.recentTxs, 1);
  assert.equal(m.transactions, 3, 'Session observation count stays cumulative and is labeled accordingly');
  assert.equal(s.averageInterval, null); assert.equal(s.totals.fees, 170001n);
  m.ingest(header(4492841, 102, 'replacement'), 5000);
  const replacement = body(4492841, [tx({})], 'replacement');
  m.ingest(replacement, 5050); m.ingest(replacement, 5051);
  assert.equal(m.transactions, 4); assert.equal(m.snapshot(20000).averageInterval, 21);
  m.ingest({ type: 'rollBackward', point: point(4492820, 'different-hash'), tip: { origin: true } }, 6000);
  assert.equal(m.blocks.length, 0); assert.equal(m.unknownRollbacks, 1); assert.equal(m.height, null);
  assert.equal(m.snapshot().totals.outputs, 0n);
});

test('empty blocks, unavailable bodies, disabled fetching and warmup remain distinct', () => {
  const m = start(); m.ingest(header(4492820, 101), 1000);
  assert.equal(m.snapshot(20000).tps, null);
  m.ingest(body(4492820), 1050);
  assert.equal(m.snapshot(20000).tps, 0); assert.equal(m.snapshot(20000).bodies, 1);
  assert.equal(m.snapshot(9000).tps, null);
  m.ingest(header(4492840, 102), 11000);
  m.ingest({ type: 'blockUnavailable', point: point(4492840) }, 12000);
  assert.equal(m.snapshot(20000).tps, null); assert.equal(m.unavailable, 1);
  assert.equal(m.blocks.at(-1).txs, null);
  assert.equal(m.snapshot(80000).tps, 0, 'Old missing bodies expire from the throughput window');
  const headers = start(false); headers.ingest(header(4492820, 101), 1000);
  headers.ingest(header(4492840, 102), 2000);
  assert.equal(headers.snapshot(20000).averageInterval, 20);
  assert.equal(headers.snapshot(20000).tps, null);
});

test('all retained collections are bounded; stop freezes duration and reset clears session', () => {
  const m = start();
  for (let i = 1; i <= 1000; i++) {
    m.ingest(header(4492800 + i * 20, 100 + i), i * 20000);
    m.ingest(body(4492800 + i * 20, [tx({})]), i * 20000 + 5);
    m.ingest({ type: 'keepAlive', roundTripMs: i }, i * 20000 + 6);
    m.updateStats({ memoryBytes: 1000, receivedBytes: i * 2000, sentBytes: i * 100 }, i * 20000 + 7);
  }
  assert.equal(m.blocks.length, MAX_BLOCKS); assert.equal(m.pings.length, 30); assert.equal(m.traffic.length, 60);
  assert.equal(m.snapshot(20000008).recentTxs, 120); assert.equal(m.transactions, 1000);
  m.stop(20000009); const s = m.snapshot(30000000);
  assert.equal(s.elapsed, 20000.009); assert.equal(s.receiveRate, 0);
  m.reset(2, 100, 0, false);
  assert.equal(m.blocks.length, 0); assert.equal(m.transactions, 0); assert.equal(m.version, null);
  assert.equal(m.snapshot(20000).tps, null); assert.equal(m.stats.receivedBytes, 0);
});
