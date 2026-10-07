import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export const iwaConfig = { transport: 'tcp', peerHost: 'backbone.cardano.iog.io', peerPort: 3001, networkMagic: 764824073 };

// Static development server only: no WebSocket handling, TCP relay or node state.
export async function startIWA({ port = 4176, host = '127.0.0.1', app = 'web' } = {}) {
  if (!['web', 'submit'].includes(app)) throw new Error('Unknown app');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      requests.push(pathname);
      if (requests.length > 200) requests.shift();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      if (pathname === '/config.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(iwaConfig));
      }
      const relative = pathname === '/' || pathname === '/.well-known/_generated_install_page.html' ? `dist/${app === 'submit' ? 'submit' : 'chain'}.html`
        : ['/manifest.webmanifest', '/.well-known/manifest.webmanifest'].includes(pathname)
          ? `${app}/manifest.webmanifest` : decodeURIComponent(pathname).slice(1);
      const filename = path.resolve(root, relative);
      if (!['web', 'submit', 'dist'].some(dir => filename.startsWith(path.join(root, dir) + path.sep))) throw new Error('Not found');
      const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html',
        '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
      const bytes = await readFile(filename);
      res.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
      res.end(bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  server.on('upgrade', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { url: `http://${host}:${server.address().port}`, requests, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = process.argv.includes('--submit') ? 'submit' : 'web';
  const server = await startIWA({ port: Number(process.env.PORT ?? (app === 'submit' ? 4177 : 4176)), app });
  console.log(`IWA static files: ${server.url}`);
  console.log('Install this URL from chrome://web-app-internals with IWA developer mode enabled.');
}
