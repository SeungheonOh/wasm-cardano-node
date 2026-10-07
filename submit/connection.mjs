import { relayTarget } from './input.mjs';
import { bridgeTarget, relayBridgeURL } from '../web/relay-url.mjs';

import { RELAYS } from '../web/relays.mjs';
export { RELAYS };

// Hosted submissions use this site's bridge. Installed apps retain direct TCP.
export function submissionTarget(value, networkMagic, origin = globalThis.location?.origin) {
  if (value.startsWith('tcp:')) return relayTarget(value, networkMagic);
  const url = new URL(value), site = new URL(origin);
  const expectedProtocol = site.protocol === 'https:' ? 'wss:' : 'ws:';
  const local = site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname);
  if ((!local && site.protocol !== 'https:') || url.protocol !== expectedProtocol || url.host !== site.host
      || url.username || url.password || url.pathname !== '/ouroboros' || url.hash)
    throw new Error('Use this site’s byte bridge and a tcp://host:port relay URL.');
  relayTarget(bridgeTarget(url).url, networkMagic);
  return url.href;
}

export function hostedTarget(tcpURL, networkMagic, origin = globalThis.location?.origin) {
  return submissionTarget(relayBridgeURL(relayTarget(tcpURL, networkMagic), origin), networkMagic, origin);
}
