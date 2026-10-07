export const MAX_CBOR_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const ERAS = { Shelley: 1, Allegra: 2, Mary: 3, Alonzo: 4, Babbage: 5, Conway: 6 };

export function transactionInput(source, selectedEra = 6) {
  if (!Object.values(ERAS).includes(selectedEra)) throw new Error('Choose a supported transaction era.');
  let text, format = 'Hex CBOR', era = selectedEra;
  if (source instanceof Uint8Array) {
    if (!source.length || source.length > MAX_FILE_BYTES) throw new Error('Choose a transaction file up to 1 MiB.');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(source).trim(); } catch { /* Binary CBOR. */ }
    if (!text || (!text.startsWith('{') && !/^[\x20-\x7e\s]*$/.test(text))) {
      if (source.length > MAX_CBOR_BYTES) throw new Error('Transaction CBOR must be at most 64 KiB.');
      return { cborHex: Array.from(source, byte => byte.toString(16).padStart(2, '0')).join(''), era, format: 'Binary CBOR' };
    }
  } else if (typeof source === 'string') text = source.trim();
  else throw new Error('Provide transaction CBOR as hex, a binary file, or a transaction envelope.');
  if (text.length > MAX_FILE_BYTES) throw new Error('Transaction input is too large.');
  if (text.startsWith('{')) {
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('The transaction envelope is not valid JSON.'); }
    if (typeof envelope.cborHex !== 'string') throw new Error('The transaction envelope needs a cborHex field.');
    if (envelope.type !== undefined) {
      const name = envelope.type === 'TxSignedShelley' ? 'Shelley' : /^Tx (Shelley|Allegra|Mary|Alonzo|Babbage|Conway)Era$/.exec(envelope.type)?.[1];
      if (!name) throw new Error('Choose a complete signed transaction envelope for Shelley through Conway, not a transaction body or witness file.');
      era = ERAS[name];
    }
    text = envelope.cborHex;
    format = 'Transaction envelope';
  }
  const cborHex = text.replace(/\s/g, '').replace(/^0x/i, '').toLowerCase();
  if (!cborHex || cborHex.length % 2 || !/^[0-9a-f]+$/.test(cborHex)) throw new Error('Enter complete CBOR bytes as an even-length hexadecimal string.');
  if (cborHex.length / 2 > MAX_CBOR_BYTES) throw new Error('Transaction CBOR must be at most 64 KiB.');
  return { cborHex, era, format };
}

export function relayTarget(url, networkMagic) {
  if (!Number.isInteger(networkMagic) || networkMagic < 0 || networkMagic > 0xffffffff) throw new Error('Network magic must be a uint32.');
  let target;
  try { target = new URL(url); } catch { throw new Error('Enter a relay as tcp://host:port.'); }
  if (target.protocol !== 'tcp:' || !target.hostname || !target.port || Number(target.port) < 1 || Number(target.port) > 65535 ||
    target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname))
    throw new Error('Use tcp://host:port with no path or credentials.');
  return target.href;
}
