# Cardano Live dashboard on Cloudflare

Public application: [cardano.isotopy.xyz](https://cardano.isotopy.xyz).
The Chain tab shows block and relay statistics and transaction contents in plain
HTML tables rendered by React. Clicking a block opens its transaction details in a
modal; the main-page transaction search opens the matching block and highlights
the transaction. Only the latest 40 observed block bodies are searchable. The [Submit transaction tab](https://cardano.isotopy.xyz/submit/)
accepts CBOR files, hex and signed JSON envelopes for local review and submission.

The browser loads the existing Haskell WASM and runs Handshake, ChainSync,
BlockFetch and KeepAlive. Enter a full TCP URL such as
`tcp://backbone.cardano.iog.io:3001` in the dashboard's Relay address field.
The browser builds a WebSocket URL such as
`wss://cardano.isotopy.xyz/ouroboros?url=tcp%3A%2F%2Fbackbone.cardano.iog.io%3A3001`.
The readable form `?url=tcp://backbone.cardano.iog.io:3001` also works.
The Worker opens an outgoing plain TCP socket to that destination and copies
binary bytes both ways.
Cloudflare does not decode, validate or store blocks and transactions, run a node,
or keep any chain state. As the transport intermediary, it can observe the bytes.
The submission tab runs Handshake, TxSubmission2 and KeepAlive in the browser
using the same bridge. Review opens no connection; Submit starts the exchange.
Submission has a three-minute deadline, including relay startup delay. Its result
describes the protocol exchange, not ledger acceptance or block inclusion.
Installed IWAs use direct TCP. Transport details are documented here rather
than repeated in the application screens.

## Free-plan boundary

The account's Workers settings reported `free_tier: true` on 2026-09-13. The
deployment script rechecks that value and refuses deployment if it cannot verify
Workers Free. It never subscribes to a paid product or changes the account plan.

- Cloudflare enforces **100,000 Worker requests per day across the account**,
  resetting at midnight UTC, and **10 ms CPU per invocation**. Requests fail at
  the free-plan limit; there is no automatic paid overage. Other Workers on this
  account share the daily allocation.
- App assets are served through Workers Static Assets without executing this
  Worker. Static asset requests are free and unlimited. Workers Cache is not
  enabled. Only the initial WebSocket upgrade is a request; WebSocket messages
  have no separate request or duration charge.
- No Durable Objects, databases, KV, R2, paid logs, queues, or scheduled jobs are
  used. Workers Logs/Traces, preview URLs and the workers.dev endpoint are disabled.
- The free-plan ceiling comes from the account plan. Upgrading this account to
  Workers Paid removes it; a per-request CPU limit or the throttles below cannot
  provide an absolute $0 spending cap on a paid account.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[platform limits](https://developers.cloudflare.com/workers/platform/limits/),
[static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## Connection limits

| Limit | Value |
| --- | --- |
| New connections per IP per Cloudflare location | 4 per 60 seconds |
| New connections across a Cloudflare location | 30 per 60 seconds |
| Session lifetime | 10 minutes; reconnect to start a new observation session |
| Inactivity | 30 seconds; protocol KeepAlive normally runs every 10 seconds |
| TCP connection establishment | 9 seconds |
| Total data | 8 MiB per direction per session |
| Browser binary message | 65,543 bytes maximum |
| Messages/chunks | 4,096 per direction per session |
| Pending writes to TCP | 131,086 bytes maximum |

Throttled upgrades return HTTP 429 with `Retry-After: 60`; limiter failures return
503 without opening a TCP socket. Rate limiter counters are local to each
Cloudflare location and eventually consistent, **not a global billing counter**.
See [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Any valid public Cardano relay TCP URL can be entered, using a DNS name, IPv4 or
bracketed IPv6 address and an explicit port. For example:
`tcp://relay.example.org:3002` or `tcp://[2001:db8::1]:3001` (documentation addresses).
The network selector fills in a convenient preset and supplies network magic;
choose the network matching the entered relay. Presets do not restrict the
destination. Cloudflare's socket service blocks private/loopback destinations,
Cloudflare IP addresses and port 25; see [TCP socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

The endpoint requires exactly one `url` query parameter. Invalid TCP URLs,
credentials, paths, extra URL parameters, cross-origin browser upgrades and text
frames are rejected. Origin checking is a browser boundary, not authentication:
non-browser clients can forge an Origin header.

## Reproduce and deploy

With the existing `dist/` WASM build present:

```sh
npm ci
npm run check:cloudflare
npm test
npm run test:cloudflare
npx wrangler deploy --dry-run --outdir build/cloudflare-worker
```

Supply `CLOUDFLARE_API_TOKEN` through your shell environment or secret manager,
then run `npm run deploy:cloudflare`. The token needs access to Workers scripts,
Workers custom domains, zone metadata, and the account's Workers settings.
Wrangler provisions the custom domain and certificate. The deployment token is
not stored in the Worker, static assets, source tree, or Wrangler configuration.

`scripts/build-cloudflare.mjs` builds an explicit public asset directory under
ignored `build/`. It includes the 11.2 MB gzipped WASM, browser modules and license
notices, including `UI_LICENSES.txt` for the bundled React runtime. Both pages
are rendered to complete HTML at build time and hydrated in the browser. This
adds no Worker rendering cost. WASM loads on Connect or transaction review,
after the interface is visible.
The raw 69.6 MB WASM, build cache, evidence and signing keys are excluded.
The `.gz` is served as a gzip file without an HTTP `Content-Encoding`, because
the browser's reactor loader decompresses it explicitly.

`test:cloudflare` runs the actual, unmodified Worker under workerd. The test enters
a local scripted TCP peer's URL with a randomly assigned port. Chromium receives a
captured block, decodes its transactions, and checks the block table. The submission
tab sends exact signed bytes to another local peer after a 65-second startup
delay, with KeepAlive continuing throughout. The test also checks review without
a connection, cancellation, a peer that does not request the body, invalid input,
throttling, origin and URL validation, network switching, responsive layouts and
that private files cannot be served. No test transaction reaches a public chain.
`npm run test:cloudflare:live` checks live Mainnet blocks, dashboard metrics and
transaction inspection through the deployed site. Set `CARDANO_RELAY=tcp://host:port`
to exercise a custom relay. It submits no transactions.
