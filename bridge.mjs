import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const peers = {
  preview: ['preview-node.play.dev.cardano.org', 3001, 2],
  preprod: ['preprod-node.play.dev.cardano.org', 3001, 1],
  mainnet: ['backbone.cardano.iog.io', 3001, 764824073],
};

// Each bridge process has one operator-configured destination; the browser cannot
// turn it into an arbitrary TCP proxy. No Cardano libraries or JSON translation.
export async function startBridge({ host = '127.0.0.1', port = 4175,
  peerHost = peers.preview[0], peerPort = 3001, networkMagic = 2 } = {}) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/config.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ peerHost, peerPort, networkMagic }));
      }
      const relative = pathname === '/' ? 'dist/chain.html'
        : pathname === '/manifest.webmanifest' ? 'web/manifest.webmanifest' : decodeURIComponent(pathname).slice(1);
      if (!relative.startsWith('web/') && !relative.startsWith('dist/')) throw new Error('Not found');
      const filename = path.resolve(root, relative);
      if (!filename.startsWith(root + path.sep)) throw new Error('Not found');
      const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html',
        '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
      const bytes = await readFile(filename);
      res.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65543, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/ouroboros' || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const tcp = net.createConnection({ host: peerHost, port: peerPort });
    sockets.add(tcp);
    const timer = setTimeout(() => { tcp.destroy(); ws.close(1011, 'TCP connect timeout'); }, 10000);
    tcp.setNoDelay(true);
    tcp.on('connect', () => clearTimeout(timer));
    ws.on('message', (bytes, binary) => {
      if (!binary) { ws.close(1003, 'Binary data required'); return; }
      if (tcp.writableLength + bytes.length > 2 * 1024 * 1024) { tcp.destroy(); ws.close(1009, 'Buffer limit'); return; }
      if (!tcp.write(bytes)) ws.pause();
    });
    tcp.on('drain', () => ws.resume());
    tcp.on('data', bytes => {
      if (ws.readyState !== WebSocket.OPEN) return tcp.destroy();
      tcp.pause();
      ws.send(bytes, { binary: true }, error => error ? tcp.destroy() : tcp.resume());
    });
    tcp.on('error', () => ws.close(1011, 'TCP connection failed'));
    tcp.on('close', () => { clearTimeout(timer); sockets.delete(tcp); ws.close(); });
    ws.on('close', () => tcp.destroy());
    ws.on('error', () => tcp.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, url: `http://${host}:${server.address().port}`, close: async () => {
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const network = process.env.NETWORK ?? 'preview';
  if (!peers[network]) throw new Error('NETWORK must be preview, preprod, or mainnet');
  const [defaultHost, defaultPort, defaultMagic] = peers[network];
  const bridge = await startBridge({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4175),
    peerHost: process.env.PEER_HOST ?? defaultHost, peerPort: Number(process.env.PEER_PORT ?? defaultPort),
    networkMagic: Number(process.env.NETWORK_MAGIC ?? defaultMagic) });
  console.log(`Cardano stream: ${bridge.url} (${network})`);
}
