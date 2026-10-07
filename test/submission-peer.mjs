// Scripted, local-only peer. This never forwards a transaction to a network.
import assert from 'node:assert/strict';
import net from 'node:net';
import { encode, decode } from './cbor.mjs';
import { frame } from '../web/transport.mjs';

export function submissionPeer({ transaction, mode = 'send', magic = 764824073, initialDelayMs = 0, reply }) {
  const records = [], protocols = new Set();
  let id, replies = 0, delivered, initialTimer, firstRequestAt;
  const requestBodies = ids => Uint8Array.from([0x82, 2, 0x9f, ...ids.flatMap(id => [...encode(id)]), 0xff]);
  function receive(protocol, bytes) {
    protocols.add(protocol);
    const message = decode(bytes);
    records.push({ protocol, message });
    const send = value => reply(protocol, value instanceof Uint8Array ? value : encode(value));
    if (protocol === 0) {
      assert.deepEqual([...message[1].keys()], [14, 15]);
      assert.deepEqual(message[1].get(15), [magic, true, 0, false]);
      send([1, 15, [magic, true, 0, false]]);
    } else if (protocol === 8) send([1, message[1]]);
    else if (protocol === 4) {
      if (message[0] === 6) {
        assert.deepEqual(message, [6]);
        if (mode === 'idle') return;
        if (mode === 'unannounced') send(requestBodies([[6, Buffer.from(transaction.id, 'hex')]]));
        else if (mode === 'bad-ack') send([0, true, 1, 1]);
        else if (initialDelayMs) initialTimer = setTimeout(() => {
          firstRequestAt = Date.now();
          send([0, true, 0, 1]);
        }, initialDelayMs);
        else { firstRequestAt = Date.now(); send([0, true, 0, 1]); }
      } else if (message[0] === 1) {
        if (replies++ === 0) {
          assert.equal(message[1].length, 1);
          [id] = message[1][0];
          assert.deepEqual(id, [6, Buffer.from(transaction.id, 'hex')].map(x => x instanceof Uint8Array ? Uint8Array.from(x) : x));
          assert.equal(message[1][0][1], transaction.cborHex.length / 2 + 7);
          if (mode === 'not-requested') send([0, true, 1, 1]);
          else if (mode === 'unknown') send(requestBodies([[6, new Uint8Array(32)]]));
          else if (mode === 'duplicate') send(requestBodies([id, id]));
          else if (mode === 'nonblocking') send([0, false, 0, 1]);
          else send(requestBodies([id]));
        } else {
          assert.deepEqual(message[1], []);
          send(requestBodies([id]));
        }
      } else if (message[0] === 3) {
        assert.equal(message[1].length, 1);
        const tx = message[1][0];
        // Node-to-node GenTx wraps the era and a tag-24 byte string.
        assert.equal(tx[0], 6);
        assert.equal(tx[1].tag, 24);
        delivered = Buffer.from(tx[1].value).toString('hex');
        assert.equal(delivered, transaction.cborHex, 'All signed CBOR bytes must survive the wire exchange');
        if (mode === 'repeat') send(requestBodies([id]));
        else send([0, true, 1, 1]);
      } else assert.deepEqual(message, [4]);
    } else throw new Error(`Unexpected protocol ${protocol}`);
  }
  return { receive, records, protocols, close: () => clearTimeout(initialTimer),
    get delivered() { return delivered; }, get firstRequestAt() { return firstRequestAt; } };
}

export async function localSubmissionPeer(options) {
  const peers = [], sockets = new Set(), errors = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const peer = submissionPeer({ ...options, reply: (protocol, payload) => socket.write(frame(protocol, payload, true)) });
    peers.push(peer);
    socket.on('close', () => { sockets.delete(socket); peer.close(); });
    socket.on('error', error => errors.push(error.message));
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const length = buffer.readUInt16BE(6);
          if (buffer.length < 8 + length) break;
          const protocol = buffer.readUInt16BE(4);
          assert.equal(protocol & 0x8000, 0);
          peer.receive(protocol, Uint8Array.from(buffer.subarray(8, 8 + length)));
          buffer = buffer.subarray(8 + length);
        }
      } catch (error) { errors.push(error.stack); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `tcp://127.0.0.1:${server.address().port}`, peers, errors,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
