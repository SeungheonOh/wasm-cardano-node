// Local-only peer replaying a captured block. No connections to public relays.
import net from 'node:net';
import assert from 'node:assert/strict';
import { encode, decode } from './cbor.mjs';
import { frame, unhex } from '../web/transport.mjs';

export async function localChainPeer(fixture) {
  const peers = [], errors = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const peer = { protocols: new Set() }; peers.push(peer);
    let buffer = Buffer.alloc(0), next = 0;
    const reply = (protocol, value) => socket.write(frame(protocol, typeof value === 'string' ? unhex(value) : encode(value), true));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => errors.push(error.message));
    socket.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt16BE(6)) {
          const length = buffer.readUInt16BE(6), protocol = buffer.readUInt16BE(4);
          const message = decode(new Uint8Array(buffer.subarray(8, 8 + length)));
          buffer = buffer.subarray(8 + length); peer.protocols.add(protocol);
          if (protocol === 0) reply(0, [1, 15, [764824073, true, 0, false]]);
          else if (protocol === 8) reply(8, [1, message[1]]);
          else if (protocol === 2) {
            if (message[0] === 4) reply(2, message[1].length ? fixture.messages.intersect : fixture.messages.tip);
            else {
              assert.deepEqual(message, [0]);
              reply(2, next === 0 ? fixture.messages.rollback : next === 1 ? fixture.messages.forward : [1]);
              next++;
            }
          } else if (protocol === 3) {
            assert.equal(message[0], 0); assert.deepEqual(message[1], message[2]);
            for (const value of fixture.messages.batch) reply(3, value);
          } else assert.fail(`Unexpected protocol ${protocol}`);
        }
      } catch (error) { errors.push(error.stack); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `tcp://127.0.0.1:${server.address().port}`, peers, errors, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
