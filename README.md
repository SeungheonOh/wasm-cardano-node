# wasm-cardano-node

**Transport limitation:** direct connections from a normal browser tab to an
unmodified Cardano relay's TCP port do not work. The current demo uses a byte
bridge and therefore does not meet a strict "no bridge" requirement. See the
[direct relay tests and explanation](docs/direct-relay.md).

A working browser stream client built from the Haskell libraries used by
`cardano-node`: Ouroboros Handshake, ChainSync, BlockFetch, KeepAlive, consensus
block/header codecs, and Cardano API. GHC compiles those libraries into a persistent
WASM reactor running in a Web Worker.

Connect to a relay, intersect at its current tip, and receive new headers, block
bodies, transactions, and rollbacks. There is no ChainDB, ledger state, UTxO set,
genesis replay, chain selection, block validation, or script execution. This is
an event consumer of one peer's view, not a validating light client. The
`cardano-node` executable and its node kernel are not started.

```text
Web app ← events → Web Worker / Haskell WASM
                         │
           Ouroboros node-to-node mini-protocols
                         │
                  WebSocket mux bytes
                         │
             byte-only WebSocket ↔ TCP bridge
                         │
                  ordinary Cardano relay
```

An ordinary browser cannot open a raw TCP socket to a relay. The supplied bridge
forwards bytes in both directions; it does not understand CBOR, terminate the
Ouroboros handshake, select chain points, decode blocks, or generate events.
The protocol connection runs end to end between WASM and the relay. The bridge
does not need a local Cardano node or chain storage.

## Run

The compiled artifacts are in `dist/` in this checkout.

```sh
cd ~/fun/wasm-cardano-node
npm ci
npm run dev
```

Open <http://127.0.0.1:4175>, then click **Connect**. The default relay is the
official Preview bootstrap peer. A live block can take a minute or more to arrive.

```sh
# Choose another network and its matching bootstrap peer.
NETWORK=mainnet npm run dev
NETWORK=preprod npm run dev

# Connect to your own relay; the destination belongs to the bridge operator.
PEER_HOST=your-relay.example PEER_PORT=3001 NETWORK_MAGIC=2 npm run dev
```

`HOST` and `PORT` configure the local listener. One bridge process has one fixed
TCP destination. Changing the web form's network only changes the handshake
magic; it does not change that destination. For an HTTPS application, serve the
bridge through TLS and use a `wss://` URL. The included server is a local
development server with same-origin WebSocket access.

## Build using sc-pab's dependency graph

This first port deliberately reuses the working, patched dependency build from
[`~/io/sc-pab`](../../io/sc-pab). It does not modify that repository, its dependency
sources, or its build directory. All new source and output live here.

Prerequisites: Python 3, Node.js 24+, sc-pab's GHC WASM **9.12.4.20260731**, and a
completed sc-pab example build. If the dependency cache is absent, first follow
sc-pab's setup/build instructions (`npm run setup`, `npm run build` there).

```sh
npm run build
```

`build.py` reads `~/.cache/sc-pab/toolchains.json`. Override paths if needed:

```sh
SC_PAB_CACHE=/path/to/sc-pab-cache \
GHC_WASM_PREFIX=/path/to/ghc-wasm npm run build
```

The build takes exact package unit IDs from the sc-pab Cabal plan, links a reactor,
runs GHC's post-linker, validates the WASM, and copies the browser WASI shim. It
does not rebuild Cardano's dependencies. `dist/manifest.json` records the output
hash, sizes, versions, and memory ceiling; `dist/dependencies.json` records direct
dependencies. Runtime dependency notices are collected into
`dist/THIRD_PARTY_NOTICES.txt` using a collector adapted from sc-pab. A fresh
independent dependency/toolchain bootstrap is not provided.

Pinned upstream versions: `cardano-api-11.0.0.0`, `ouroboros-consensus-3.0.1.0`,
`ouroboros-network-1.1.0.0`, `cardano-diffusion-1.0.0.0`. The existing sc-pab
WASM portability patches remain essential to this build.

## Use in a web app

Serve `web/` and `dist/` together, preserving their relative locations. No bundler
is required. Serve `.wasm.gz` as gzip **bytes**, without HTTP `Content-Encoding:
gzip`: the worker decompresses it explicitly.

```js
import { connect } from './web/client.mjs';

const stream = connect({
  url: 'ws://127.0.0.1:4175/ouroboros',
  networkMagic: 2,                // Preview: 2, Preprod: 1, Mainnet: 764824073
  blocks: true,                  // false subscribes to headers and rollbacks only
  async onEvent(event, stats) {
    switch (event.type) {
      case 'block':
        for (const tx of event.transactions) {
          console.log(tx.id, tx.cborHex);
        }
        break;
      case 'rollBackward':
        console.log('Peer rolled back to', event.point);
        break;
    }
  },
  onError: console.error,
});

// On component unmount or user disconnect:
stream.close();
```

The client awaits `onEvent`, then acknowledges the worker. The Haskell peer waits
for the event sink and completes one block fetch before requesting the next
header, so a slow application does not build an unbounded event queue. KeepAlive
runs independently. `close()` terminates the worker, socket, timers and WASM heap.
Create a new connection to reconnect; each connection starts at the then-current
tip, with no catch-up or delivery guarantee for the disconnected interval.

| Event | Contents |
| --- | --- |
| `connected` | Negotiated node-to-node version and network magic |
| `intersect` | Initial point at the peer's current tip and the advertised tip |
| `await` | The peer is waiting for its chain to change |
| `rollForward` | Header point, block number, and advertised tip |
| `block` | Point, era, transaction IDs and transaction CBOR hex |
| `rollBackward` | Rollback point and advertised tip |
| `blockUnavailable` | A requested body is unavailable, e.g. after a fork switch |

Slot and block numbers are decimal strings to preserve 64-bit values. A point is
`{slot, hash}` or `{origin: true}`. A block event is not a ledger event: no UTxO,
balance, reward, or state transition is computed. Applications decide what to do
with rollbacks and how much of their own event history to retain. The demo keeps
only 80 display rows and does not persist transactions.

ChainSync can first send a rollback to the selected intersection; that is normal
protocol positioning. With diffusion pipelining, a just-announced header can be
ahead of the tip advertised alongside it. Events intentionally preserve the
peer's values. A block event is emitted after decoding its body; inclusion does
not establish finality. The only body check is that its point matches the single
requested header, with exactly one block in the batch.

## Verification and limits

```sh
npm test                 # Offline tests executing the compiled WASM and mux
npm run test:live        # Preview TCP relay, 90-second observation
npm run test:browser     # Real Chromium → WebSocket bridge → Preview relay

PEER_HOST=backbone.cardano.iog.io NETWORK_MAGIC=764824073 \
SECONDS=60 REQUIRE_TX=1 EVIDENCE_NAME=mainnet npm run test:live
```

Browser tests require Playwright Chromium (`npx playwright-core install chromium`
or set `CHROMIUM_PATH`). Live tests depend on the network producing a block during
the observation period. Evidence and desktop/mobile screenshots go in `evidence/`.
See [verification notes](docs/verification.md) for the observed runs.

The linked artifact is approximately **65.4 MiB raw / 10.5 MiB gzip**. Observed
WASM linear memory was approximately **16–17 MiB** while streaming Preview and
transaction-bearing Mainnet blocks. This is not total browser memory: compiled
machine code, the downloaded module and JavaScript objects also occupy memory.
The linker caps linear memory at 512 MiB; the small observed usage is not a
promise about every possible input. Individual ChainSync messages are limited
to 256 KiB and BlockFetch messages to 2 MiB, with a separate 2 MiB transport
buffer limit. No buffer limit depends on chain height or chain length.

This port targets the current Shelley-family live stream, verified with Conway.
It negotiates node-to-node versions 14 and 15. Older/future incompatible peers
fail negotiation or decoding. It does not implement historical Byron transaction
events, peer discovery, failover, transaction submission, mempool events, or
local-state queries. Peer trust is inherited from your selected relay and bridge.

## Port-specific fix

`src/VersionData.hs` adapts the upstream handshake version-data codec. Upstream
compares a decoded `Int` network magic to `0xffffffff`; on WASM32 that bound
overflows to `-1`, rejecting every magic including Preview's `2`. This adapter
uses `Integer` for the unsigned 32-bit range check and handles both CBOR integer
representations. The original upstream data types, version negotiation, peer
state machines and message codecs are retained. Tests cover both ends of uint32,
the signed boundary, all three standard networks, invalid bounds and mismatch.

GHC's pinned JSFFI implementation also fails to compile an asynchronous import
returning the `JSString` newtype. The byte receiver returns `JSVal` and wraps it
as `JSString` after the promise is forced. Every asynchronous import result,
including `()`, is explicitly evaluated before proceeding.

References: [Ouroboros network specification](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf),
[official relay topology](https://book.world.dev.cardano.org/environments.html),
[GHC WASM and JSFFI](https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html).
