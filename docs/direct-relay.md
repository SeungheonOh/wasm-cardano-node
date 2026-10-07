# Direct relay connection from a normal browser tab

This document covers a normal browser tab with no proxy, extension, installed
Isolated Web App, or native application. The bridge-based demo does **not**
satisfy that transport requirement. The separate
[installed IWA mode](../README.md#direct-tcp-in-an-isolated-web-app) now supports
direct TCP and has been tested against Mainnet relays; it changes the app's
installation model, not the normal-tab result below.

`npm run probe:direct` opens unmodified Chromium on a local static test page and
attempts WebSocket connections directly to the Mainnet and Preview bootstrap
relays on port 3001, using both `ws://` and `wss://`. The local HTTP server serves
only an empty page; it has no WebSocket endpoint or TCP forwarding behavior.

The completed run in Chromium 151 found:

- `TCPSocket` and `chrome.sockets` were unavailable, even in a secure,
  cross-origin-isolated normal page.
- Both Mainnet and Preview reset both direct WebSocket attempts: all four
  `ws://` / `wss://` connections failed before opening.
- Native Node.js raw-TCP controls successfully negotiated Ouroboros v15 with
  both of those same relay addresses.

The probe also runs the same WASM client in Node.js as an explicitly separate
raw-TCP control. A successful Node connection does not count as browser success.
Detailed outcomes, browser console messages and control results are written to
`evidence/direct-relay-probe.json`.

The protocol mismatch cannot be fixed by compiling additional Haskell modules:

1. [Cardano's node-to-node interface uses TCP and Ouroboros framing](https://developers.cardano.org/docs/developers/curriculum/production/network-protocol/).
2. A browser WebSocket first requires an HTTP WebSocket handshake, followed by
   WebSocket framing. It cannot simply send the original Ouroboros bytes as the
   first TCP bytes.
3. [Normal web applications cannot open arbitrary TCP sockets](https://developer.chrome.com/docs/iwa/direct-sockets).
   Chrome's Direct Sockets API is restricted to Isolated Web Apps, which are
   outside this normal-tab test's scope.
4. [WebTransport uses HTTP/3/QUIC](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API),
   so using it also requires support from the remote endpoint. It is not a
   general TCP connection API.

A normal browser could connect directly if a relay operator exposed Ouroboros
over a compatible WebSocket (or another browser-supported transport) endpoint.
The original relay's TCP `host:port` does not supply that endpoint. No compatible
public raw-Ouroboros WebSocket endpoint was found during this investigation.
Ogmios speaks a different, JSON protocol and is not a direct connection to the
relay's node-to-node protocol.

To probe a specific advertised WebSocket endpoint without changing the client:

```sh
npm run probe:direct -- wss://your-relay.example/path
```

A WebSocket opening alone does not establish Ouroboros compatibility; the probe
reports that distinction. Installed IWA tests run separately as `npm run test:iwa`
and `npm run test:iwa:bundle`.
