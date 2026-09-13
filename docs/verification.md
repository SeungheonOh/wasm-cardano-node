# Verification

Observed on 2026-09-13 UTC (2026-09-12 in America/Chicago).

| Run | Result |
| --- | --- |
| GHC WASM build | Compiled and linked against sc-pab's existing patched Cardano graph; `-Wall -Werror`; `wasm-tools validate` passed |
| Preview live, 90 seconds | Negotiated node-to-node v15, intersected at slot 122610683, decoded a new Conway header and block at slot 122610804 |
| Mainnet live, 60 seconds | Negotiated v15, decoded four Conway blocks and three transactions; no chain history downloaded |
| Chromium 151.0.7922.34 | Real browser Worker/WASM → local WebSocket bridge → Preview TCP relay; decoded the live block; no console/page errors |
| Chromium, Mainnet | Repeated with the final pinned build; decoded a Conway block with 15 transactions at slot 197701127, using 17.1 MiB WASM linear memory; no console/page errors |
| Browser layouts | Desktop 1280×1100 and mobile 390×844; no horizontal overflow; disconnect returned the UI to its idle state |
| Offline tests | 13 passed, including the compiled WASM peer and codecs |

Preview linear memory was **16,908,288 bytes**; Mainnet was **17,301,504 bytes**.
Mainnet's observed inbound wire traffic was 9,289 bytes and outbound 580 bytes.
These figures measure a short observation of ordinary blocks, not a whole-node
memory requirement, total browser memory, or an exhaustive worst-case bound.
The peer may announce a header ahead of its advertised tip due to pipelining.

The browser reached its first live block in approximately 43 seconds, mostly
waiting for production. The initial protocol rollback to the intersection is
normal positioning and is displayed as received.

Offline tests cover:

- The WASM32 handshake fix: 0, Preview, Preprod, Mainnet, 2^31, 2^32−1, negative
  and overflowing magic, and a wrong network.
- An independently scripted peer with actual captured Conway header/body bytes,
  fragmented mux input, tip intersection, block fetch, and a subsequent rollback.
- Header-only mode, unavailable bodies, duplicate blocks, invalid protocol
  messages, and moving-tip intersection retries with no history fallback.
- 250 forward/fetch/rollback cycles in one WASM instance under a 64 MiB linear
  memory assertion. The consumer in the test retains events outside WASM.
- Mux direction, segmentation, partial headers, multiple protocols in one input,
  buffer limits, cancellation, and event-consumer backpressure.

`test/fixtures/preview.json` contains public wire messages captured from
`preview-node.play.dev.cardano.org:3001` and the expected header identity. These
are decoded by the original Haskell codecs in offline tests. The JavaScript
CBOR helper is confined to the scripted test peer.

The pinned upstream ChainSync decoder can itself throw `printf: bad formatting
char 'd'` while formatting an invalid-message error on WASM32. The connection
still fails and no invalid event is accepted; tests assert rejection without
depending on that upstream diagnostic string.

The short live runs do not establish protocol conformance for every era, browser
engine, or peer implementation. A fresh independent toolchain/dependency build
was not attempted: the port reuses the user's completed sc-pab build as requested.
Connection trust, reconnect recovery, long-term operation and ledger validation
are outside this client's implemented behavior.

Raw results: `evidence/live.json`, `evidence/mainnet.json`, `evidence/browser.json`, `evidence/browser-mainnet.json`,
plus wire captures and browser screenshots. Generated evidence is not required
to build or run the client.
