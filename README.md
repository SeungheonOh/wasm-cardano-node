# wasm-cardano-node

**Two transport modes:** the normal-tab demo uses a WebSocket ↔ TCP byte bridge.
The installed [Isolated Web App](#direct-tcp-in-an-isolated-web-app) connects
directly to ordinary Cardano TCP relays using Chrome Direct Sockets, with no
proxy or native helper. Normal tabs still cannot open these TCP sockets; see
the [direct relay tests and explanation](docs/direct-relay.md).

The live dashboard at [cardano.isotopy.xyz](https://cardano.isotopy.xyz) uses a
Cloudflare byte bridge. See [deployment and free-plan limits](docs/cloudflare.md).
The [Submit transaction tab](https://cardano.isotopy.xyz/submit/) reviews signed
CBOR locally and submits it using TxSubmission2 through the same bridge. The
separate installed [Cardano Submit app](#cardano-submit) uses direct browser TCP.

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

## Direct TCP in an Isolated Web App

The same WASM worker and transaction view can run as an installed IWA. Its
`TCPSocket` reads and writes Ouroboros mux bytes directly to `host:3001`.
The default is Mainnet; the network selector also switches the default relay.
Enter another `tcp://host:port` to use your own relay.

To install the self-contained local development bundle:

1. In desktop Chrome, enable `chrome://flags/#enable-isolated-web-apps` and
   `chrome://flags/#enable-isolated-web-app-dev-mode`, then relaunch.
2. Open `chrome://web-app-internals` and choose **Install IWA from Signed Web Bundle**.
3. Select `dist/cardano-live.swbn`, open **Cardano**, then **Connect**.

The bundle includes the UI, WASM, codecs and runtime. No local server needs to
be running, including when the installed app restarts. This was verified in
Chromium 152.0.7977.64 on Linux using IWA developer mode; it is not a claim of
general Chrome Web Store or unmanaged production distribution support.

Rebuild the bundle after changing the UI or WASM:

```sh
npm run build:iwa       # Packages the existing compiled WASM and current web files
npm run test:iwa:bundle # Installs in a temporary Chrome profile; receives live txs
```

The local signing identity is generated in ignored `build/iwa-development-key.pem`
and is never included in the bundle. `dist/iwa.json` records the bundle origin.
Keep that key to retain the app's identity across local rebuilds. The manifest
declares `direct-sockets` and `cross-origin-isolated`; the client uses a narrowly
scoped Trusted Types policy for its bundled worker URL.

For live UI development, `npm run dev:iwa` serves static files at
`http://127.0.0.1:4176`. Install that URL using **Install IWA via Dev Mode Proxy**
on the same Chrome internals page. Chrome's development mode fetches app files
from this server; `iwa.mjs` has no WebSocket endpoint or TCP forwarding code.
`npm run test:iwa` exercises that installation and stops the static server after
the handshake, then requires a new transaction-bearing block to arrive over TCP.
`CHROMIUM_PATH` can override the test browser executable.

Observed on 2026-09-13 UTC: the development install received 18 Mainnet
transactions from `backbone.cardano.iog.io:3001` after the static server stopped
(18.4 MiB WASM memory). The signed bundle received six transactions directly
from `backbone.mainnet.cardanofoundation.org:3001` with no app server started
(16.9 MiB). Both negotiated v15 and passed desktop/mobile transaction-view
checks with no console errors. Evidence is in ignored `evidence/iwa*.json` and
screenshots. These are short live runs, not long-term resource bounds.

See Chrome's [Direct Sockets documentation](https://developer.chrome.com/docs/iwa/direct-sockets)
and [IWA installation instructions](https://developer.chrome.com/docs/iwa/introduction#test-your-app).

## Cardano Submit

The public site has a [Submit transaction tab](https://cardano.isotopy.xyz/submit/)
next to the chain dashboard. It reviews CBOR locally and submits through the
same WebSocket-to-TCP bridge. A separate installed app supports direct TCP:

```sh
npm run build          # Compile the shared Haskell WASM, if not built already
npm run build:submit   # Package the separate signed app
npm run dev:submit     # Optional static preview at http://127.0.0.1:4177
```

Install `dist/cardano-submit.swbn` through Chrome's **Install IWA from Signed
Web Bundle** on `chrome://web-app-internals`, with Isolated Web Apps and IWA
developer mode enabled. Open **Cardano Submit**, drop a complete signed
transaction, review its ID, fee, inputs, outputs and key witness count, select the
network and `tcp://host:port` relay, then press **Submit transaction**. Choose a
relay for the network the transaction was built for. The default era is Conway.

The app accepts binary `.cbor` files, hexadecimal text (including whitespace and
an optional `0x` prefix), and Cardano CLI signed transaction JSON envelopes.
Envelopes select their stated era; raw CBOR uses the era selector. Complete
transactions from Shelley through Conway are supported by the codecs, with
Conway exercised in the submission tests. Transaction bodies and witness files
alone are not complete transactions. The transaction limit is 64 KiB; the input
file limit is 1 MiB. Decoding rejects trailing bytes and any input that would be
rewritten on serialization. It never signs transactions or asks for wallet keys.

Reviewing happens locally, before any relay connection. The local static preview
remains inspection-only. The installed IWA always uses
Direct Sockets and contains all runtime assets; it needs no app server or bridge.
A relay on a private network may require Chrome's local-network
permission. See the [Direct Sockets documentation](https://developer.chrome.com/docs/iwa/direct-sockets).

The client holds one transaction in memory and starts only Handshake,
TxSubmission2 and KeepAlive. It offers the ID and wire size when requested, then
sends the original transaction bytes if the relay requests the body. It closes
after the relay acknowledges the outstanding ID and requests more. If the relay
acknowledges the ID without fetching the body, the app explicitly reports that
no body was sent. The upstream protocol permits waiting in its idle state:
ordinary relays can delay their first ID request by 60 seconds. The app displays
elapsed time and KeepAlive responses while waiting, with a separate three-minute
overall deadline and a Close connection button. There is no automatic retry or
persistent queue. The protocol uses the upstream
[TxSubmission2 time limits](https://ouroboros-network.cardano.intersectmbo.org/ouroboros-network/protocols/Ouroboros-Network-Protocol-TxSubmission2-Codec.html).

**Sent to relay** means the socket write completed. TxSubmission2 does not report
ledger acceptance, rejection reasons, or block inclusion. An interrupted exchange
can leave delivery unknown. Closing the connection cannot recall transmitted
bytes. The app decodes structure and counts witnesses; it does not verify
signatures, execution, UTxOs, balances, or validity against the chain.

The independent local signing identity is kept in ignored
`build/submission-development-key.pem`. Preserve it to retain this app's identity
across rebuilds. The bundle origin is recorded in `dist/submission-iwa.json`.
`submit/` contains the separate UI and Worker, and `src/Submission.hs` implements
the original Haskell TxSubmission2 peer. Both apps share this repository's own
WASM toolchain, Cardano codecs and transport framing.

```sh
npm test             # Includes offline submission state-machine and CBOR tests
npm run test:submit  # Installed signed app → scripted local TCP peer
```

The browser test checks an actual binary file drop, JSON envelope, hex paste,
exact transaction bytes received over Chrome TCP, no-body-request handling,
cancellation, invalid input, and mobile layouts. It uses a local peer that never
forwards transactions and broadcasts nothing onto a public chain.

## Live dashboard

The React chain tab uses standard HTML controls and tables for observed block height,
epoch position, slot age, transaction activity, rollbacks, relay timing and memory.
Chain and Relay show compact summaries with expandable details. Recent blocks
sits directly below them, with transaction search above the table; protocol
events are collapsed until opened.
The recent-block table shows transaction counts, slot intervals and transaction
CBOR sizes for the latest 40 blocks. Click a block to open a modal with its full
hash and every decoded transaction. Transaction details include inputs, outputs,
assets, metadata and raw CBOR. Search by transaction ID or prefix on the main page
to open the matching block with that transaction expanded and highlighted. Search
covers received bodies in the latest 40 observed blocks; it is not a chain indexer.
The submission tab is a separate page, so navigating away closes the observation
connection. Loading and reviewing a transaction share one panel; the destination,
Submit action and delivery status share a second panel. On narrow screens,
submission follows review. All statistics come from received events.

React components live in `ui/`. `npm run build:ui` bundles the two entry points
to `dist/chain-ui.mjs` and `dist/submit-ui.mjs`; the dev commands, Cloudflare
packaging and IWA packaging run it automatically. The build also renders the full
initial HTML for both pages, so controls and tables appear before JavaScript loads.
React hydrates that interface; WASM starts only on Connect or transaction review.
React and its licenses are
packaged locally, with no CDN or runtime build service. The shared stylesheet
uses square borders, restrained colors and no shadows or gradients.

Metrics have explicit scopes:

- **Session counters** count received headers, transactions, and rollback events,
  including observations later rolled back. They reset when reconnecting.
- **Recent statistics** retain at most 120 block summaries from the peer's current
  branch. Rollbacks remove orphaned summaries. A rollback outside this window
  clears recent statistics and reports unknown depth instead of guessing.
- **Block timing/density** use slot differences between consecutive block heights,
  not local arrival intervals. Density is observed blocks per slot in that sample;
  empty slots are normal and do not imply missed blocks.
- **Transaction rate** covers up to 60 seconds of received observations, after a
  10-second warmup. It is unavailable when fetching is disabled or a body in the
  window is missing.
- **KeepAlive round trip** measures each completed Ouroboros KeepAlive exchange
  using a monotonic clock, including runtime scheduling. In bridge mode it includes
  the bridge path. The latest value and mean of up to 30 samples are shown.
- **Header → body** measures local elapsed time from the header event to the
  decoded body event, including fetching, decoding and event scheduling. It is
  not network-wide propagation latency. Receive/send counters cover mux traffic;
  receive rate uses a bounded sample window. Memory means WASM linear memory only.
- **Epoch/slot age** use the configured network's Shelley clock anchor. These
  mappings are verified against the [network genesis files](https://book.world.dev.cardano.org/)
  and [Lucid's slot configuration](https://github.com/Anastasia-Labs/lucid-evolution/blob/main/packages/plutus/src/time.ts).
  Age depends on the local wall clock; the epoch progress is at the observed tip.

The signed IWA tests require multiple Mainnet blocks and exercise table values,
block inspection and 320/390/768px layouts without an app server.
Set `CHECK_DASHBOARD=1 REQUIRE_TX=1` to exercise the same checks in the ordinary
browser test. Neither mode queries producer metrics, the relay's mempool, stake
distribution, or finality: those cannot be inferred from this stream.

## Independent build

All build recipes, portability patches, dependency pins, and runtime packaging
are in this repository. A fresh checkout downloads its own compiler and sources
and builds the entire dependency graph. No sibling checkout, prebuilt Cardano
package database, Plinth compiler, or external project cache is required.

On Ubuntu/Debian, install the native build prerequisites:

```sh
sudo apt-get install build-essential python3 git curl jq patch pkg-config \
  autoconf automake libtool m4 happy alex unzip xz-utils zstd libgmp-dev libffi-dev
```

Use Python 3.12+ and Node.js 24+ for the project commands. The pinned toolchain
installer also supplies its own Node, Cabal, WASI SDK, and WASM validation tools.
Linux x86_64 is the verified host; the upstream installer also has Linux ARM64
and macOS bindists, which this project has not tested.

```sh
npm ci
npm run setup           # Download/install GHC WASM 9.12.4.20260731
npm run build           # Fetch, patch, compile dependencies, and link the reactor
npm test
npm run build:iwa
```

`npm run build` also runs setup when needed. The initial build is substantially
larger and slower than incremental builds. Everything generated by the Haskell
build stays in ignored `.wasm-build/`; browser artifacts are written to `dist/`.
The source checkout is the only project directory needed by these commands.
The preview's last successful artifacts are preserved if compilation fails.

Optional settings:

```sh
WASM_CARDANO_CACHE=/path/to/dedicated-cache npm run build
GHC_WASM_PREFIX=/path/to/compatible-compiler npm run build
```

An explicit compiler override must have the exact pinned version. It supplies
compiler tools only: the Cabal configuration, package indexes, compiled package
store, project plan, and dependency build output still belong to this project.
Never point `WASM_CARDANO_CACHE` at another project's build cache. Setup refuses
to overwrite an incomplete or unexpected compiler installation; move a failed
installation aside and rerun setup. The installer limits XZ decompression to one
thread to avoid large memory spikes. Package builds run serially by default:
the pinned Cabal bindist can otherwise race while unpacking a package's separate
libraries on a fresh cache. After a successful first build, `BUILD_JOBS=2` can
enable parallel incremental builds.

Build inputs:

- `wasm/toolchain.json` pins the upstream compiler installer and compiler version.
- `wasm/dependencies.json` pins source archives by SHA-256 and Git sources by commit.
- `wasm/patches/` contains the required WASM32 portability changes.
- `cabal.wasm.project.in` pins repository index states and core package versions.
- `wasm/cabal.config.in` isolates Cabal's indexes, store, and logs.
- `build.py` builds `exe:cardano-stream`, generates its JavaScript FFI, validates
  WASM, packages the browser WASI shim, and gathers dependency notices.

The core versions are Cardano API 11.0.0.0, Ouroboros consensus 3.0.1.0,
Ouroboros network 1.1.0.0, Cardano diffusion 1.0.0.0, and Plutus 1.63.0.0.
`dist/manifest.json` records compiler and artifact hashes/sizes;
`dist/dependencies.json` records direct dependencies from this build's Cabal plan.
See [porting notes](wasm/PORTING.md) for the copied build recipe's provenance and
what the patches change.

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
          console.log(tx.id, tx.feeLovelace, tx.inputs, tx.outputs);
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
| `keepAlive` | Completed KeepAlive round trip in milliseconds (`roundTripMs`) |
| `rollForward` | Header point, block number, and advertised tip |
| `block` | Point, era, decoded transaction details and complete transaction CBOR hex |
| `rollBackward` | Rollback point and advertised tip |
| `blockUnavailable` | A requested body is unavailable, e.g. after a fork switch |

Slot and block numbers are decimal strings to preserve 64-bit values. A point is
`{slot, hash}` or `{origin: true}`. A block event is not a ledger event: no UTxO,
balance, reward, or state transition is computed. Applications decide what to do
with rollbacks and how much of their own event history to retain. The demo keeps
only 80 chain event rows, 120 block summaries and the latest 40 block bodies,
and does not persist transactions. Optional `onStats` receives memory/received/sent byte
counters once per second, including while ChainSync awaits the next block.

Expand a transaction card to inspect input references, output addresses and ADA,
native assets, mint/burn quantities, fees, validity slots, metadata, output datums,
reference script hashes, collateral, withdrawals, required signers and raw CBOR.
Search observed transactions by ID or prefix to open their block modal. Rollbacks
remove orphaned block bodies and their search results together. Output totals include
change; input addresses and amounts are not resolved because this client has no
historical UTxO data. Metadata and datum JSON are exact strings, and ledger
quantities are decimal strings to avoid JavaScript number rounding. The typed
event shape is in [web/client.d.mts](web/client.d.mts).

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

The linked artifact is approximately **66.2 MiB raw / 10.6 MiB gzip**. Observed
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
events, peer discovery, failover, mempool events, or
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
