# Verification

Verified on 2026-09-13 using Linux x86_64 and Chromium 152.0.7977.64.

## Cloudflare deployment

[cardano.isotopy.xyz](https://cardano.isotopy.xyz) serves the **Cardano Live
dashboard**, version `dbc45e90-51be-4471-8cce-25aebd8eb745`. The existing internal
Worker resource ID is `cardano-submit`; its public assets and entry point are
the React dashboard at `/`, with a separate submission tab at `/submit/`.
Both render standard HTML controls and tables with square borders and no shadows.
The React components and state live in `ui/`; esbuild produces locally hosted
bundles and pre-rendered HTML. Cloudflare and IWA packaging include both and
the runtime licenses. There is no standalone brand heading, transport label or
transaction totals panel. Transactions are shown inside their block modal.
Chain and Relay are compact summaries with expandable details, immediately
followed by Recent blocks and its transaction search. Protocol events are
collapsed by default. Submission groups loading/review separately from the
destination, action and delivery status, and stacks them in that order on mobile.
Search retains the latest 40 observed block bodies; unit checks cover rollback
and eviction removing orphaned or expired search results, late orphan bodies,
and searching blocks containing more than 60 transactions.

The account reported `free_tier: true` before and after deployment. Limits remain 4 new
connections/IP/minute and 30/location/minute, with workers.dev / previews
disabled. Dashboard sessions are bounded to 10 minutes, 8 MiB per direction and
4,096 messages/chunks per direction. No paid product was enabled.

The React UI against the actual Worker under workerd, using a local captured-chain
peer, decoded one
block and its two transactions through Handshake, ChainSync, BlockFetch and
KeepAlive. Block modals, transaction expansion, exact-ID and prefix search,
auto-expansion and highlighting, Escape/Close dismissal, network switching,
disconnect and 320/390/768/1280-pixel layouts passed with no browser errors.
With the UI bundle deliberately held back, the full initial HTML already shows
controls, navigation, statistics and search, without a WASM download or relay
connection. Connect remains disabled while settings are held back, then enables
after its destination and handler are ready; an early click cannot be lost.
The test enters a custom TCP URL and randomly assigned port through the dashboard;
no Worker destination is replaced or mocked. HTTP 429 / Retry-After, origin
restrictions, relay URL validation and private-file
rejection also passed. The submission page and its modules are now public assets.

The same browser test followed the submission tab and dropped a binary CBOR file.
Review decoded its ID and contents locally without opening a relay connection.
The submission-flow regression at 2026-09-14T01:32:18Z passed with a local peer
waiting 65 seconds after Submit before requesting IDs; KeepAlive
continued throughout and the peer received the exact signed transaction bytes
using only mini-protocols 0, 4 and 8. The styled Choose file button opens the
browser file chooser and loads a signed JSON envelope. Hex paste, cancellation,
a peer that did not request the body, invalid CBOR and mobile layouts also passed.
The latest layout regression uses an immediate local peer and also checks that
metrics expand, blocks directly follow the summaries, and mobile submission
follows the transaction review.
No transaction was sent to a public chain. Submission screenshots are in ignored
`evidence/cloudflare-submission-local.png`.

Worker upload: 6.31 KiB (2.44 KiB compressed); reported startup: 6 ms. Local
evidence is in ignored `evidence/cloudflare-dashboard-local.json`. Reproduction
and cost boundaries are in [Cloudflare deployment](cloudflare.md).

A public browser run at 2026-09-14T01:32:40Z received a Mainnet block with six
transactions, inspected its modal and CBOR, searched and highlighted a transaction,
and reviewed that same transaction in the submission tab with no relay connection
or public submission. Browser errors were zero, and WASM memory was 17.2 MiB.
Evidence: `evidence/cloudflare-final.json` and its screenshots. The compact layout
was then deployed in the version above. Its public HTML contains the complete
compact dashboard, and 320/390/768/1280px layout checks passed. A subsequent
public Choose file review reached Ready to submit in 12 seconds, using binary
CBOR and the actual hosted WASM. Two earlier cold public checks exceeded their
loading waits; the retry succeeded without a code change. These observations
do not establish a bound on public cold-start download time.

The deployed general relay URL change passed a live browser check using the
Cardano Foundation relay's resolved IPv4 address, `tcp://195.49.96.164:3001`,
entered directly into the dashboard. Chromium decoded one Mainnet block and
three transactions, with working transaction inspection, filtering, raw CBOR
and mobile layout, no browser errors and 16.4 MiB WASM linear memory. No preset
ID was sent. Evidence is in ignored `evidence/cloudflare-relay-url.json` and
its accompanying screenshots. The five targeted URL/bridge tests, Worker
type-check and deployment dry run also passed.

Before the plain HTML redesign, the public HTTPS dashboard regression passed
against IOG Mainnet: at least three
live blocks, transaction contents and filtering, all three chart modes, block
inspection, consensus/epoch metrics, relay timing, fullscreen presentation and
mobile layouts, with no browser errors. The runtime used 17.9 MiB of WASM linear
memory. Evidence and screenshots are in ignored `evidence/cloudflare-dashboard.*`
and `evidence/cloudflare-dashboard-{desktop,mobile,presentation}.png`.

## Independent source build

The toolchain and Cardano package store were created fresh inside this checkout's
`.wasm-build/`. Compilation ran inside a Bubblewrap mount namespace with the host
filesystem read-only and the home directory hidden, exposing only this project
under home. The previous source checkout and package caches were confirmed
inaccessible to the build process. No compiled Cardano packages were copied in.

The build compiled the pinned dependency graph through Cardano API and linked
`exe:cardano-stream` with `-Wall -Werror`. `wasm-tools validate` passed. The first
build exposed two environment assumptions now handled by the recipe: native
Happy/Alex prerequisites and serial package builds to avoid Cabal racing while
unpacking multiple libraries from one archive.

The submission exports were then compiled incrementally using the same isolated
build environment and project-owned dependency store. The current shared
artifact includes both the observer and submission exports:

| Artifact | Result |
| --- | --- |
| GHC WASM | 9.12.4.20260731 |
| Compiler installer revision | `8fd59591635cb47ad7db124562039bea8441cae8` |
| Cardano API / consensus / network | 11.0.0.0 / 3.0.1.0 / 1.1.0.0 |
| WASM | 69,601,182 bytes |
| Gzipped WASM | 11,188,372 bytes |
| WASM SHA-256 | `751d4ce26b96aa4210a44f506d3df104917a1bd67b38252f0099fb378130ec4f` |

Original clean-build inputs, their hashes, isolation details and baseline manifest are
recorded in ignored `evidence/independent-build.json`; the compiler log is in
`evidence/independent-build.log`. The build recipe and native prerequisites are
in [README.md](../README.md#independent-build).

## Offline checks

The previous full offline run passed all **31 tests** against the independently
built WASM and transport code. The general relay URL change adds one test and
was checked with all five targeted Cloudflare tests above. The full suite covers:

- Handshake network magic: 0, Preview, Preprod, Mainnet, 2^31, 2^32−1,
  negative/overflowing values, and rejection of a wrong network.
- Actual captured Conway headers and bodies, fragmented mux input, tip
  intersection, block fetching, and subsequent rollback.
- Mainnet transaction IDs, fees, input references, output amounts, validity,
  metadata and raw CBOR checked against captured and independently decoded wire
  data, with output address prefix checks.
- Header-only mode, unavailable bodies, extra blocks, invalid protocol messages,
  and moving-tip intersection retries with no history fallback.
- 250 forward/fetch/rollback cycles in one WASM instance under a 64 MiB linear
  memory assertion. The test consumer retains events outside WASM.
- Mux direction, segmentation, partial headers, multiple protocols in one input,
  buffer limits, cancellation, and event-consumer backpressure.
- Bounded dashboard statistics, rollback handling, incomplete observations,
  epoch clocks and exact declared amount totals.
- Cloudflare bridge byte ordering, client disconnect cleanup, binary frame,
  byte/message/queue limits, idle/lifetime expiry, and same-origin hosted submission
  destinations using general TCP URLs.
- Submission input handling for binary CBOR, hex, JSON envelopes (including
  Unicode descriptions), era selection, limits and direct-TCP-only destinations.
- Local inspection and rejection of malformed, unsupported-era and trailing CBOR
  before any networking. Captured transaction IDs and signed bytes are preserved.
- TxSubmission2 initial announcement, body request, empty nonblocking replies,
  acknowledgement and completion, using only mini-protocols 0, 4 and 8.
- Independent peer checks of advertised transaction ID, wire size and exact body
  bytes, including fragmented incoming mux data. Acknowledgement without a body
  request never produces a sent milestone. Invalid acknowledgements, unknown,
  unannounced, duplicate or repeated ID requests fail. Failed socket writes never
  emit the sent milestone.

`test/fixtures/preview.json` and `test/fixtures/mainnet.json` contain public wire
messages decoded by the original Haskell codecs. The JavaScript CBOR helper is
confined to the independently scripted test peer and fixture comparisons.

The pinned upstream ChainSync decoder can itself throw `printf: bad formatting
char 'd'` while formatting an invalid-message error on WASM32. The connection
still fails and no invalid event is accepted; tests assert rejection without
depending on that upstream diagnostic string.

## Live browser checks

Both observer regression runs used the initial shared WASM (before the submission
idle-timeout fix) and passed with no page or
console errors:

| Mode | Live result |
| --- | --- |
| Normal browser → byte bridge → IOG Mainnet relay | 1 block and 18 transactions; transaction inspection, filtering and raw CBOR passed; 17.9 MiB WASM memory |
| Signed IWA → Cardano Foundation Mainnet relay | 3 blocks and 9 transactions; 17.4 MiB WASM memory; no static server or WebSocket connection |

The signed IWA regression checked KeepAlive timing, block timing, traffic statistics, all three
chart views, block inspection, fullscreen presentation, and layouts at 320, 390,
768 and 1280 pixels. Presentation resets the viewport after the fullscreen
transition completes. Both modes checked transaction details and mobile layout.
Each test installs or opens a fresh browser context.

The signed bundle was installed from `dist/cardano-live.swbn` in Chrome IWA
developer mode. Direct Sockets was available in the app and its Worker. This
verifies the local developer installation, not production distribution approval.

Raw regression results: `evidence/browser-submission-regression.json` and
`evidence/iwa-bundle.json`, with their accompanying screenshots. The original
clean-build tests are in `evidence/independent-tests.log`. Older
Preview/live evidence files describe earlier builds and are not required to
build or run the client.

## Separate submission app

`npm run test:submit` installed `dist/cardano-submit.swbn` into a fresh Chromium
152 profile and used the browser's actual Direct Sockets API to connect to an
independent, scripted TCP peer bound to loopback. That peer never forwards bytes
to any public node. No app server was running during submission, all app assets
came from the signed bundle, and no WebSocket was opened.

The test dropped an actual binary CBOR file, loaded a signed JSON envelope,
and pasted hex. Local review opened no relay connection. After explicit Submit,
the peer received the expected transaction ID and byte-for-byte original signed
CBOR through TxSubmission2. It observed only Handshake, TxSubmission2 and
KeepAlive. The peer deliberately waited 65 seconds before its first ID request,
with KeepAlive exchanges continuing throughout. This reproduces the default
node's startup delay and catches both premature protocol and Worker timeouts.
WASM linear memory was 16.4 MiB in this exchange.

The test also verified acknowledgement without fetching, cancellation while
waiting for an ID request, the overall deadline (with only the Worker deadline
timer accelerated), malformed/trailing CBOR rejection, disabled submission
in an ordinary tab, and layouts at 320, 390, 768 and 1280 pixels. Page/console
errors and public-chain broadcasts were both zero. Chrome's local-network
permission was explicitly granted to the test app for the loopback peer; its
manifest declares the relevant permission policies.

Evidence: `evidence/submission-browser.json`, `evidence/submission-desktop.png`
and `evidence/submission-mobile.png`. This proves a browser TCP protocol exchange,
not acceptance into a public relay's mempool or block inclusion.

### Relay startup timeout fix (app 0.1.1)

A user-provided transaction reproduced `ExceededTimeLimit … SingIdle` on both
the IOG and Cardano Foundation Mainnet relays. Handshake and KeepAlive succeeded,
but no transaction ID was requested before the app's incorrect 30-second limit.
The independent delayed-peer browser test failed with the same error before the
fix. The original fast scripted peer had omitted this startup delay.

The node's `defaultTxSubmissionInitDelay` is 60 seconds. The upstream
[TxSubmission2 codec](https://ouroboros-network.cardano.intersectmbo.org/ouroboros-network/protocols/Ouroboros-Network-Protocol-TxSubmission2-Codec.html)
intentionally has no idle-state timeout. The client now uses that upstream policy
and a separate three-minute application deadline, with elapsed time, KeepAlive
responses and readable failure messages. All 27 offline tests and the delayed
installed-browser test passed against the artifact above.

With the user's explicit instruction to submit their exact CBOR, the rebuilt
signed IWA connected directly to `backbone.cardano.iog.io:3001`. The relay first
requested IDs at 60.25 seconds, requested the transaction body at 60.30 seconds,
and acknowledged the outstanding ID at 60.35 seconds. The client sent the body
and completed the exchange without any proxy or chain-sync protocol. The CBOR's
witness map was empty; this was an unsigned transaction and the test does not
establish ledger acceptance. No signing was performed. Public submission is not
part of the automated test suite.

The before/after traces are in ignored `evidence/user-submission-before.json`
and `evidence/user-submission-after.json`; offline output is in
`evidence/submission-timeout-tests.log`. The delayed browser regression output is
in `evidence/submission-delay-before.log` and `evidence/submission-delay-after.log`.

## Limits

The tests do not establish conformance for every era, browser engine or peer
implementation. Live memory figures measure WASM linear memory during short
observations, not total browser memory or an exhaustive worst-case bound.
The initial rollback to the intersection is normal protocol positioning.
The peer may announce a header ahead of its advertised tip due to pipelining.
Connection trust, automatic reconnect recovery, long-term operation and ledger
validation remain outside this client's implemented behavior.
