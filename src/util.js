// Shared helpers: CRC32, zlib (de)compression, text encoding.
// Uses only web-standard APIs so the library runs in Node >= 18 and browsers.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const encodeText = (s) => encoder.encode(s);
export const decodeText = (b) => decoder.decode(b);

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** zlib-wrapped deflate (RFC 1950), as required by PNG. */
export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate'));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate'));

/** Normalize Buffer / ArrayBuffer / typed array input to a Uint8Array view. */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Expected a Uint8Array, Buffer or ArrayBuffer');
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Wrap user data in a versioned envelope so future readers can migrate it. */
export const FORMAT = 'scenefile';
export const FORMAT_VERSION = 1;

export function wrap(data, kind) {
  return { format: FORMAT, version: FORMAT_VERSION, kind, savedAt: new Date().toISOString(), data };
}

export function unwrap(envelope) {
  if (!envelope || envelope.format !== FORMAT) throw new Error('Embedded payload is not a scenefile envelope');
  if (envelope.version > FORMAT_VERSION) {
    throw new Error(`Scene payload version ${envelope.version} is newer than supported (${FORMAT_VERSION})`);
  }
  return envelope;
}
