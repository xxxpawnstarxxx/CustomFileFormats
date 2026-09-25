// .scene.png — a regular PNG with scene data stored in a compressed iTXt chunk.
//
// iTXt is a standard ancillary text chunk, so every image viewer/editor that
// doesn't know about it simply skips it and shows the picture. This is the
// same technique Excalidraw uses for .excalidraw.png.

import { crc32, concat, decodeText, deflate, encodeText, inflate, toBytes, unwrap, wrap } from './util.js';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PNG_KEYWORD = 'application/vnd.scenefile+json';

export function isPng(bytes) {
  bytes = toBytes(bytes);
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Split a PNG into its chunks: [{ type, data }]. Verifies CRCs. */
export function readChunks(bytes) {
  bytes = toBytes(bytes);
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new Error('Truncated PNG chunk header');
    const length = view.getUint32(pos);
    const type = decodeText(bytes.subarray(pos + 4, pos + 8));
    const dataEnd = pos + 8 + length;
    if (dataEnd + 4 > bytes.length) throw new Error(`Truncated PNG chunk ${type}`);
    const crc = view.getUint32(dataEnd);
    if (crc32(bytes, pos + 4, dataEnd) !== crc) throw new Error(`Bad CRC in PNG chunk ${type}`);
    chunks.push({ type, data: bytes.subarray(pos + 8, dataEnd) });
    pos = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (chunks.at(-1)?.type !== 'IEND') throw new Error('PNG is missing IEND');
  return chunks;
}

/** Serialize chunks back into a PNG file. */
export function writeChunks(chunks) {
  const parts = [PNG_SIGNATURE];
  for (const { type, data } of chunks) {
    const buf = new Uint8Array(12 + data.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, data.length);
    buf.set(encodeText(type), 4);
    buf.set(data, 8);
    view.setUint32(8 + data.length, crc32(buf, 4, 8 + data.length));
    parts.push(buf);
  }
  return concat(parts);
}

// iTXt layout: keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
async function buildITXt(keyword, text) {
  const compressed = await deflate(encodeText(text));
  return concat([encodeText(keyword), new Uint8Array([0, 1, 0, 0, 0]), compressed]);
}

async function parseITXt(data) {
  const nul = data.indexOf(0);
  const keyword = decodeText(data.subarray(0, nul));
  const compressed = data[nul + 1] === 1;
  let pos = nul + 3;
  pos = data.indexOf(0, pos) + 1; // skip language tag
  pos = data.indexOf(0, pos) + 1; // skip translated keyword
  const body = data.subarray(pos);
  return { keyword, text: decodeText(compressed ? await inflate(body) : body) };
}

function keywordOf(chunk) {
  if (chunk.type !== 'iTXt') return null;
  const nul = chunk.data.indexOf(0);
  return decodeText(chunk.data.subarray(0, nul));
}

/**
 * Embed scene data into a PNG. Returns new PNG bytes; pixels are untouched.
 * Any scene data already in the file is replaced.
 */
export async function embedPng(pngBytes, data, { keyword = PNG_KEYWORD } = {}) {
  const chunks = readChunks(pngBytes).filter((c) => keywordOf(c) !== keyword);
  const sceneChunk = { type: 'iTXt', data: await buildITXt(keyword, JSON.stringify(wrap(data, 'png'))) };
  // Put it before the image data so streaming readers find it without reading the pixels.
  const firstIdat = chunks.findIndex((c) => c.type === 'IDAT');
  chunks.splice(firstIdat === -1 ? chunks.length - 1 : firstIdat, 0, sceneChunk);
  return writeChunks(chunks);
}

/** Read the full envelope ({ format, version, kind, savedAt, data }) or null if absent. */
export async function extractPngEnvelope(pngBytes, { keyword = PNG_KEYWORD } = {}) {
  const chunk = readChunks(pngBytes).find((c) => keywordOf(c) === keyword);
  if (!chunk) return null;
  const { text } = await parseITXt(chunk.data);
  return unwrap(JSON.parse(text));
}

/** Read the embedded scene data, or null if the PNG has none. */
export async function extractPng(pngBytes, opts) {
  const env = await extractPngEnvelope(pngBytes, opts);
  return env ? env.data : null;
}

/** Remove embedded scene data, returning a plain PNG. */
export function stripPng(pngBytes, { keyword = PNG_KEYWORD } = {}) {
  return writeChunks(readChunks(pngBytes).filter((c) => keywordOf(c) !== keyword));
}
