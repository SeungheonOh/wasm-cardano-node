// Clock anchors: Cardano Operations Book genesis files and Shelley transition
// (mainnet epoch 208 / slot 4492800; preprod epoch 4 / slot 86400).
// https://book.world.dev.cardano.org/environments/{mainnet,preprod,preview}/shelley-genesis.json
// https://cips.cardano.org/cip/cip-0059/annex/feature-table
// https://github.com/Anastasia-Labs/lucid-evolution/blob/main/packages/plutus/src/time.ts
export const NETWORKS = {
  764824073: { name: 'Mainnet', slot: 4492800, epoch: 208, time: 1596059091000, epochLength: 432000 },
  1: { name: 'Preprod', slot: 86400, epoch: 4, time: 1655769600000, epochLength: 432000 },
  2: { name: 'Preview', slot: 0, epoch: 0, time: 1666656000000, epochLength: 86400 },
};
export const MAX_BLOCKS = 120;
const mean = xs => xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null;
const pointKey = point => point?.hash ?? null;

export function slotClock(magic, slot) {
  const config = NETWORKS[magic], value = Number(slot);
  if (!config || slot == null || !Number.isSafeInteger(value) || value < config.slot) return null;
  const relative = value - config.slot;
  return { epoch: config.epoch + Math.floor(relative / config.epochLength),
    slotInEpoch: relative % config.epochLength, epochLength: config.epochLength,
    time: config.time + relative * 1000 };
}

// Only bounded summaries are retained here. Transaction bodies belong to the
// bounded block viewer; cumulative counters describe observations, not a ledger.
export class ChainMetrics {
  constructor(magic = 764824073) { this.reset(magic); }
  reset(magic, now = performance.now(), wall = Date.now(), bodies = true) {
    Object.assign(this, { magic, bodies, started: now, wallStarted: wall, ended: null,
      connectedAt: null, active: false, version: null, point: null, height: null, tip: null,
      blocks: [], headers: 0, transactions: 0, rollbacks: 0, unavailable: 0,
      deepestRollback: 0, unknownRollbacks: 0, rollbackNotice: '', era: null,
      pings: [], lastPingAt: null, stats: { receivedBytes: 0, sentBytes: 0, memoryBytes: 0 },
      traffic: [], lastTrafficAt: now, previousBytes: 0, observationStarted: null });
  }
  stop(now = performance.now()) { this.active = false; this.ended = now; }
  updateStats(stats, now = performance.now()) {
    this.stats = { ...this.stats, ...stats };
    if (now - this.lastTrafficAt >= 1000) {
      const rate = Math.max(0, (this.stats.receivedBytes - this.previousBytes) * 1000 / (now - this.lastTrafficAt));
      this.traffic.push({ at: now, rate });
      if (this.traffic.length > 60) this.traffic.shift();
      this.lastTrafficAt = now; this.previousBytes = this.stats.receivedBytes;
    }
  }
  ingest(event, now = performance.now()) {
    if (event.type === 'connected') {
      this.active = true; this.connectedAt = now; this.version = event.version;
    }
    if (event.tip) this.tip = event.tip;
    if (event.type === 'keepAlive') {
      this.pings.push(event.roundTripMs); if (this.pings.length > 30) this.pings.shift();
      this.lastPingAt = now;
    }
    if (event.type === 'intersect') {
      this.point = event.point;
      this.height = pointKey(event.tip?.point) === pointKey(event.point) ? event.tip?.blockNo ?? null : null;
      this.observationStarted = now;
    }
    if (event.type === 'rollForward') {
      this.headers++;
      this.point = event.point; this.height = event.blockNo;
      if (!this.blocks.some(block => block.hash === event.point.hash)) {
        this.blocks.push({ hash: event.point.hash, slot: event.point.slot, height: event.blockNo,
          at: now, body: false, unavailable: false, txs: null, bytes: null, fetchMs: null,
          fees: 0n, outputs: 0n, collateral: 0, assets: 0, metadata: 0 });
        if (this.blocks.length > MAX_BLOCKS) this.blocks.shift();
      }
    }
    if (event.type === 'block') {
      const block = this.blocks.find(block => block.hash === event.point.hash);
      if (!block || block.body) return;
      block.body = true; block.txs = event.transactions.length;
      block.fetchMs = Math.max(0, now - block.at); block.bytes = 0;
      for (const tx of event.transactions) {
        block.bytes += tx.sizeBytes;
        block.fees += BigInt(tx.feeLovelace);
        block.outputs += BigInt(tx.outputLovelace);
        block.collateral += Number(tx.collateralInputs.length > 0);
        block.assets += Number(tx.mint.length > 0 || tx.outputs.some(output => output.assets.length > 0));
        block.metadata += Number(tx.metadataJson !== null);
      }
      this.transactions += block.txs; this.era = event.era.replace(/Era$/, '');
    }
    if (event.type === 'blockUnavailable') {
      this.unavailable++;
      const block = this.blocks.find(block => block.hash === event.point.hash);
      if (block) block.unavailable = true;
    }
    if (event.type === 'rollBackward') {
      this.rollbacks++;
      const index = this.blocks.findIndex(block => block.hash === pointKey(event.point));
      const currentIsTarget = pointKey(this.point) === pointKey(event.point);
      const depth = currentIsTarget ? 0 : index >= 0 ? this.blocks.length - index - 1 : null;
      if (depth === null) this.unknownRollbacks++;
      else this.deepestRollback = Math.max(this.deepestRollback, depth);
      this.rollbackNotice = depth === 0 ? '' : depth === null ? 'Rollback beyond the retained window. Recent statistics restarted.'
        : `Peer rolled back ${depth} observed block${depth === 1 ? '' : 's'}. Recent statistics updated.`;
      this.blocks = index >= 0 ? this.blocks.slice(0, index + 1) : [];
      this.point = event.point;
      this.height = this.blocks.at(-1)?.height ??
        (pointKey(event.tip?.point) === pointKey(event.point) ? event.tip?.blockNo ?? null : null);
    }
  }
  snapshot(now = performance.now(), wall = Date.now()) {
    const end = this.ended ?? now, clock = slotClock(this.magic, this.point?.slot);
    const intervals = [];
    for (let i = 1; i < this.blocks.length; i++) {
      const previous = this.blocks[i - 1], block = this.blocks[i];
      if (BigInt(block.height) - BigInt(previous.height) === 1n) {
        const seconds = Number(BigInt(block.slot) - BigInt(previous.slot));
        if (seconds > 0) intervals.push({ block, seconds });
      }
    }
    const averageInterval = mean(intervals.map(sample => sample.seconds));
    const bodies = this.blocks.filter(block => block.body);
    const recentTxs = bodies.reduce((sum, block) => sum + block.txs, 0);
    const elapsed = this.observationStarted === null ? 0 : (end - this.observationStarted) / 1000;
    const windowSeconds = Math.min(60, Math.max(0, elapsed));
    const windowBlocks = this.blocks.filter(block => block.at > end - windowSeconds * 1000);
    const windowComplete = windowBlocks.every(block => block.body);
    const tps = this.bodies && elapsed >= 10 && windowComplete
      ? windowBlocks.reduce((sum, block) => sum + block.txs, 0) / windowSeconds : null;
    const peerLead = this.height != null && this.tip?.blockNo != null
      ? (BigInt(this.tip.blockNo) > BigInt(this.height) ? BigInt(this.tip.blockNo) - BigInt(this.height) : 0n).toString() : null;
    const totals = bodies.reduce((sum, b) => ({ fees: sum.fees + b.fees, outputs: sum.outputs + b.outputs,
      collateral: sum.collateral + b.collateral, assets: sum.assets + b.assets, metadata: sum.metadata + b.metadata,
      bytes: sum.bytes + b.bytes }), { fees: 0n, outputs: 0n, collateral: 0, assets: 0, metadata: 0, bytes: 0 });
    return { clock, tipAge: clock ? (wall - clock.time) / 1000 : null, elapsed: (end - this.started) / 1000,
      averageInterval, intervals, density: averageInterval === null ? null : 100 / averageInterval,
      peerLead, tps, windowSeconds, recentTxs, bodies: bodies.length, totals,
      meanFetch: mean(bodies.map(b => b.fetchMs)), meanPing: mean(this.pings), ping: this.pings.at(-1) ?? null,
      pingAge: this.lastPingAt === null ? null : (now - this.lastPingAt) / 1000,
      receiveRate: this.active ? this.traffic.at(-1)?.rate ?? 0 : 0 };
  }
}
