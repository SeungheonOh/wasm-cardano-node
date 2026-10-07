/** A TCP relay address, independent of the dashboard's network presets. */
export function parseRelayURL(value) {
  const message = 'Enter a relay URL in the form tcp://host:port (IPv6: tcp://[address]:port).';
  if (typeof value !== 'string') throw new Error(message);
  const input = value.trim();
  if (input.length > 2048 || /[\s\u0000-\u001f\u007f\\?#@]/u.test(input)) throw new Error(message);
  let url;
  try { url = new URL(input); } catch { throw new Error(message); }
  const port = Number(url.port);
  if (url.protocol !== 'tcp:' || !url.hostname || !url.port || !Number.isInteger(port)
      || port < 1 || port > 65535 || url.username || url.password || !['', '/'].includes(url.pathname))
    throw new Error(message);
  // Canonicalize DNS names, IPv4 and bracketed IPv6 using WHATWG host rules.
  let hostname;
  try { hostname = new URL(`http://${url.host}`).hostname; } catch { throw new Error(message); }
  return { url: `tcp://${hostname}:${port}`, host: hostname.replace(/^\[|\]$/g, ''), port };
}

export function bridgeTarget(url) {
  if ([...url.searchParams.keys()].join(',') !== 'url')
    throw new Error('Use /ouroboros?url=tcp://host:port.');
  return parseRelayURL(url.searchParams.get('url'));
}

export function relayBridgeURL(value, origin = globalThis.location?.origin) {
  const target = parseRelayURL(value), url = new URL('/ouroboros', origin);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The byte bridge requires an HTTP or HTTPS site.');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('url', target.url);
  return url.href;
}
