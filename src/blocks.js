// Block container used inside the GLB "SCNE" chunk.
//
// Like a .blend file, the scene is stored as a list of named data blocks
// (scene settings, objects, collections, editor state, thumbnail, …). Each
// block is JSON or raw binary and is compressed individually, so a reader
// can list blocks and pull out just the one it needs.
//
// Layout (all integers little-endian):
//   "SCF2"            4-byte magic
//   uint32            header length in bytes
//   header            UTF-8 JSON, space-padded to 4-byte alignment
//   payload           block bytes, at the offsets listed in the header
//
// header = { format, version, savedAt, generator, blocks: [
//   { name, type: "json" | "binary", mime?, compression: "zlib" | "none",
//     offset, length, rawLength } ] }

import { concat, decodeText, deflate, encodeText, FORMAT, inflate, toBytes } from './util.js';

export const BLOCKS_MAGIC = 'SCF2';
export const BLOCKS_VERSION = 2;

// Formats that are already compressed; zlib would only waste time.
const PRECOMPRESSED = /^(image\/(png|jpeg|webp|avif|ktx2)|video\/|audio\/|application\/(zip|gzip))/;

/**
 * @param {Map<string, {type:'json', value:any} | {type:'binary', bytes:Uint8Array, mime?:string}>} blocks
 * @param {{ generator?: string }} [meta]
 */
export async function encodeBlocks(blocks, { generator = 'scenefile' } = {}) {
  const entries = [];
  const payload = [];
  let offset = 0;
  for (const [name, block] of blocks) {
    const raw = block.type === 'json' ? encodeText(JSON.stringify(block.value)) : toBytes(block.bytes);
    let stored = raw;
    let compression = 'none';
    if (!(block.mime && PRECOMPRESSED.test(block.mime))) {
      const z = await deflate(raw);
      if (z.length < raw.length) [stored, compression] = [z, 'zlib'];
    }
    const entry = { name, type: block.type, compression, offset, length: stored.length, rawLength: raw.length };
    if (block.mime) entry.mime = block.mime;
    entries.push(entry);
    payload.push(stored);
    offset += stored.length;
  }

  const header = {
    format: FORMAT,
    version: BLOCKS_VERSION,
    savedAt: new Date().toISOString(),
    generator,
    blocks: entries,
  };
  let headerBytes = encodeText(JSON.stringify(header));
  const pad = (4 - (headerBytes.length % 4)) % 4;
  if (pad) headerBytes = concat([headerBytes, encodeText(' '.repeat(pad))]);

  const prefix = new Uint8Array(8);
  prefix.set(encodeText(BLOCKS_MAGIC), 0);
  new DataView(prefix.buffer).setUint32(4, headerBytes.length, true);
  return concat([prefix, headerBytes, ...payload]);
}

export function isBlockContainer(data) {
  return data.length >= 8 && decodeText(data.subarray(0, 4)) === BLOCKS_MAGIC;
}

/** Read only the header (block list, sizes) without decompressing anything. */
export function readBlocksHeader(data) {
  data = toBytes(data);
  if (!isBlockContainer(data)) throw new Error('Not a scenefile block container');
  const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  const header = JSON.parse(decodeText(data.subarray(8, 8 + headerLength)));
  if (header.format !== FORMAT) throw new Error('Block container has an unknown format');
  if (header.version > BLOCKS_VERSION) {
    throw new Error(`Scene data version ${header.version} is newer than supported (${BLOCKS_VERSION})`);
  }
  return { header, payloadStart: 8 + headerLength };
}

/** Decode every block. Returns { header, blocks: Map<name, block> }. */
export async function decodeBlocks(data) {
  data = toBytes(data);
  const { header, payloadStart } = readBlocksHeader(data);
  const blocks = new Map();
  for (const entry of header.blocks) {
    const start = payloadStart + entry.offset;
    if (start + entry.length > data.length) throw new Error(`Scene block "${entry.name}" is truncated`);
    const stored = data.subarray(start, start + entry.length);
    const raw = entry.compression === 'zlib' ? await inflate(stored) : stored.slice();
    if (raw.length !== entry.rawLength) throw new Error(`Scene block "${entry.name}" has the wrong size`);
    blocks.set(
      entry.name,
      entry.type === 'json'
        ? { type: 'json', value: JSON.parse(decodeText(raw)) }
        : { type: 'binary', bytes: raw, ...(entry.mime && { mime: entry.mime }) },
    );
  }
  return { header, blocks };
}
