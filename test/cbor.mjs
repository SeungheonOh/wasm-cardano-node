// Small test-peer CBOR helper, independent of the Haskell production codecs.
// Supports only the forms needed for client requests and scripted responses.
export function encode(value) {
  const head = (major, number) => {
    const n = BigInt(number), prefix = major << 5;
    if (n < 24n) return [prefix | Number(n)];
    const width = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 0xffffffffn ? 4 : 8;
    return [prefix | ({ 1: 24, 2: 25, 4: 26, 8: 27 })[width],
      ...Array.from({ length: width }, (_, i) => Number((n >> BigInt(8 * (width - 1 - i))) & 255n))];
  };
  const go = v => {
    if (typeof v === 'boolean') return [v ? 0xf5 : 0xf4];
    if (typeof v === 'number' || typeof v === 'bigint') return BigInt(v) < 0n ? head(1, -1n - BigInt(v)) : head(0, v);
    if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
    if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(go)];
    if (v instanceof Map) return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...go(k), ...go(x)])];
    throw new Error('Unsupported test CBOR');
  };
  return Uint8Array.from(go(value));
}

export function decode(bytes) {
  let offset = 0;
  const go = () => {
    if (offset >= bytes.length) throw new Error('Truncated test CBOR');
    const first = bytes[offset++], major = first >> 5, ai = first & 31;
    if (first === 0xf4 || first === 0xf5) return first === 0xf5;
    if (major === 4 && ai === 31) {
      const result = [];
      while (bytes[offset] !== 0xff) result.push(go());
      offset++; return result;
    }
    let length = BigInt(ai);
    if (ai >= 24) {
      if (ai > 27) throw new Error('Unsupported test CBOR');
      length = 0n;
      for (let n = 0; n < 2 ** (ai - 24); n++) length = length * 256n + BigInt(bytes[offset++]);
    }
    if (major === 0 || major === 1) {
      const v = major === 0 ? length : -1n - length;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    if (major === 2) { const value = bytes.slice(offset, offset + Number(length)); offset += Number(length); return value; }
    if (major === 4) return Array.from({ length: Number(length) }, go);
    if (major === 5) return new Map(Array.from({ length: Number(length) }, () => [go(), go()]));
    throw new Error('Unsupported test CBOR');
  };
  const result = go();
  if (offset !== bytes.length) throw new Error('Trailing test CBOR');
  return result;
}
