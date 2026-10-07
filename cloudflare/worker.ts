import { connect } from 'cloudflare:sockets';
import { bridgeTarget } from '../web/relay-url.mjs';
import { startBridge } from './bridge';

const reject = (status: number, message: string) => new Response(message, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    ...(status === 429 ? { 'Retry-After': '60' } : {}) },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ouroboros') return reject(404, 'Not found');
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return reject(426, 'A WebSocket connection is required.');
    if (request.headers.get('Origin') !== url.origin) return reject(403, 'Open the dashboard on this site.');
    let peer;
    try { peer = bridgeTarget(url); }
    catch (error) { return reject(400, error instanceof Error ? error.message : 'Invalid relay URL.'); }
    try {
      // These are abuse limits local to each Cloudflare location. The account's
      // Workers Free plan supplies the global daily request ceiling / $0 cap.
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip) return reject(403, 'Client address unavailable.');
      if (!(await env.PER_IP.limit({ key: ip })).success || !(await env.PER_LOCATION.limit({ key: 'all' })).success)
        return reject(429, 'Too many relay connections. Wait a minute before retrying.');
    } catch { return reject(503, 'Connection limits are unavailable. Try again later.'); }
    let tcp: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Cloudflare enforces destination restrictions after DNS resolution,
      // including private / loopback addresses. No VPC binding is configured.
      tcp = connect({ hostname: peer.host, port: peer.port }, { secureTransport: 'off', allowHalfOpen: false });
      void tcp.closed.catch(() => {});
      await Promise.race([tcp.opened, new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error('Connect timeout')), 9000);
      })]);
    } catch {
      void tcp?.close().catch(() => {});
      return reject(502, 'Could not connect to this public TCP relay. Check its host and port.');
    } finally { if (timer !== undefined) clearTimeout(timer); }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    startBridge(server, tcp);
    return new Response(null, { status: 101, webSocket: client });
  },
} satisfies ExportedHandler<Env>;
