import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { liveStream } from './runtime.mjs';

const events = [];
const wire = [];
const stats = await liveStream({ host: process.env.PEER_HOST, port: Number(process.env.PEER_PORT ?? 3001),
  magic: Number(process.env.NETWORK_MAGIC ?? 2), seconds: Number(process.env.SECONDS ?? 90),
  onWire: (direction, bytes) => wire.push({ direction, hex: Buffer.from(bytes).toString('hex') }),
  onEvent: event => {
    events.push(event);
    console.log(JSON.stringify(event.type === 'block' ? { ...event, transactions: event.transactions.map(tx => ({ id: tx.id, cborBytes: tx.cborHex.length / 2 })) } : event));
  } });
assert(events.some(e => e.type === 'connected'), 'Handshake completed');
assert(events.some(e => e.type === 'intersect'), 'Started at the peer tip');
assert(events.some(e => e.type === 'block'), 'Received a live block body');
if (process.env.REQUIRE_TX === '1') assert(events.some(e => e.type === 'block' && e.transactions.length), 'Received transactions');
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
const name = process.env.EVIDENCE_NAME ?? 'live';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name');
await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), JSON.stringify({ testedAt: new Date().toISOString(), stats, events }, null, 2));
await writeFile(new URL(`../evidence/${name}-wire.json`, import.meta.url), JSON.stringify(wire));
console.log(JSON.stringify({ success: true, ...stats }));
