// .scene.glb — a regular binary glTF 2.0 file with scene/workspace data in an
// extra chunk.
//
// A GLB is: 12-byte header, a JSON chunk, an optional BIN chunk, and then any
// number of further chunks. The glTF 2.0 spec requires loaders to ignore
// chunk types they don't recognize, so three.js, Blender, Babylon.js, model
// viewers, etc. load the model normally. The scene data rides along in a
// chunk of type "SCNE", holding a container of named data blocks (see
// blocks.js); the higher-level editor is SceneGlb in scene-doc.js.
//
// Separately, `updateGltf()` lets you edit the glTF JSON itself — e.g. put
// per-node data in `nodes[i].extras`, which Blender imports as custom
// properties and three.js exposes as `object.userData`.

import { BLOCKS_VERSION, decodeBlocks, encodeBlocks, isBlockContainer, readBlocksHeader } from './blocks.js';
import { concat, decodeText, encodeText, inflate, toBytes, unwrap } from './util.js';

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
export const CHUNK_SCENE = 0x454e4353; // "SCNE"

const chunkName = (type) =>
  String.fromCharCode(type & 0xff, (type >> 8) & 0xff, (type >> 16) & 0xff, (type >>> 24) & 0xff);

export function isGlb(bytes) {
  bytes = toBytes(bytes);
  return bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === MAGIC;
}

/** Parse a GLB into { json, chunks: [{ type, data }] } (chunks excludes the JSON chunk). */
export function readGlb(bytes) {
  bytes = toBytes(bytes);
  if (!isGlb(bytes)) throw new Error('Not a GLB file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}`);
  const length = view.getUint32(8, true);
  if (length > bytes.length) throw new Error('Truncated GLB');

  let json = null;
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= length) {
    const chunkLength = view.getUint32(pos, true);
    const type = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (start + chunkLength > length) throw new Error(`Truncated GLB chunk ${chunkName(type)}`);
    const data = bytes.subarray(start, start + chunkLength);
    if (type === CHUNK_JSON && json === null) json = JSON.parse(decodeText(data));
    else chunks.push({ type, data });
    pos = start + chunkLength;
  }
  if (json === null) throw new Error('GLB has no JSON chunk');
  return { json, chunks };
}

function padded(data, padByte) {
  const extra = (4 - (data.length % 4)) % 4;
  if (!extra) return data;
  const out = new Uint8Array(data.length + extra).fill(padByte);
  out.set(data);
  return out;
}

/** Serialize { json, chunks } back into a GLB. JSON first, BIN second, others after. */
export function writeGlb({ json, chunks }) {
  const ordered = [
    { type: CHUNK_JSON, data: padded(encodeText(JSON.stringify(json)), 0x20) },
    ...chunks.filter((c) => c.type === CHUNK_BIN),
    ...chunks.filter((c) => c.type !== CHUNK_BIN).map((c) => ({ type: c.type, data: padded(c.data, 0) })),
  ];
  const parts = [];
  for (const { type, data } of ordered) {
    const header = new Uint8Array(8);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, data.length, true);
    hv.setUint32(4, type, true);
    parts.push(header, data);
  }
  const body = concat(parts);
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, MAGIC, true);
  hv.setUint32(4, 2, true);
  hv.setUint32(8, 12 + body.length, true);
  return concat([header, body]);
}

// Version 1 SCNE chunks: 4-byte LE compressed length, then zlib-compressed JSON
// envelope. Still readable; files are rewritten as version 2 block containers.
async function decodeLegacySceneChunk(data) {
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  return unwrap(JSON.parse(decodeText(await inflate(data.subarray(4, 4 + size)))));
}

const findSceneChunk = (glb) => glb.chunks.find((c) => c.type === CHUNK_SCENE);

/**
 * Read the scene blocks from a GLB (bytes or a readGlb() result).
 * Returns { header, blocks: Map<name, block> }, or null if the GLB has none.
 */
export async function readSceneBlocks(glb) {
  if (!glb.chunks) glb = readGlb(glb);
  const chunk = findSceneChunk(glb);
  if (!chunk) return null;
  if (isBlockContainer(chunk.data)) return decodeBlocks(chunk.data);
  const env = await decodeLegacySceneChunk(chunk.data);
  return {
    header: { format: env.format, version: env.version, savedAt: env.savedAt, blocks: [] },
    blocks: new Map([['data', { type: 'json', value: env.data }]]),
  };
}

/** List stored blocks (name, type, sizes) without decompressing them. */
export function listSceneBlocks(glbBytes) {
  const chunk = findSceneChunk(readGlb(glbBytes));
  if (!chunk) return null;
  if (!isBlockContainer(chunk.data)) return [{ name: 'data', type: 'json', compression: 'zlib', legacy: true }];
  return readBlocksHeader(chunk.data).header.blocks;
}

/** Replace the SCNE chunk of a parsed GLB in place with the given blocks. */
export async function setSceneChunk(glb, blocks, meta) {
  glb.chunks = glb.chunks.filter((c) => c.type !== CHUNK_SCENE);
  glb.chunks.push({ type: CHUNK_SCENE, data: await encodeBlocks(blocks, meta) });
  glb.json.asset ??= { version: '2.0' };
  glb.json.asset.extras = {
    ...glb.json.asset.extras,
    scenefile: { chunk: 'SCNE', encoding: 'scenefile-blocks', version: BLOCKS_VERSION },
  };
  return glb;
}

/** Write scene blocks into a GLB, replacing any existing scene data. Returns new bytes. */
export async function writeSceneBlocks(glbBytes, blocks, meta) {
  return writeGlb(await setSceneChunk(readGlb(glbBytes), blocks, meta));
}

/**
 * Embed free-form scene data into a GLB (stored as the "data" block). Other
 * blocks already in the file (objects, editor state, …) are kept. The model
 * itself is untouched. A small marker is also written to
 * `asset.extras.scenefile` so tools that only read the JSON can see it.
 */
export async function embedGlb(glbBytes, data) {
  const glb = readGlb(glbBytes);
  const blocks = (await readSceneBlocks(glb))?.blocks ?? new Map();
  blocks.set('data', { type: 'json', value: data });
  return writeGlb(await setSceneChunk(glb, blocks));
}

/** Read the "data" block as an envelope ({ format, version, kind, savedAt, data }), or null. */
export async function extractGlbEnvelope(glbBytes) {
  const scene = await readSceneBlocks(glbBytes);
  const block = scene?.blocks.get('data');
  if (!block) return null;
  const { format, version, savedAt } = scene.header;
  return { format, version, kind: 'glb', savedAt, data: block.value };
}

/** Read the embedded free-form scene data, or null if the GLB has none. */
export async function extractGlb(glbBytes) {
  const env = await extractGlbEnvelope(glbBytes);
  return env ? env.data : null;
}

/** Remove embedded scene data, returning a plain GLB. */
export function stripGlb(glbBytes) {
  const glb = readGlb(glbBytes);
  glb.chunks = glb.chunks.filter((c) => c.type !== CHUNK_SCENE);
  if (glb.json.asset?.extras) {
    delete glb.json.asset.extras.scenefile;
    if (!Object.keys(glb.json.asset.extras).length) delete glb.json.asset.extras;
  }
  return writeGlb(glb);
}

/**
 * Edit the glTF JSON in place and return new GLB bytes. `fn` receives the
 * parsed JSON and may mutate it or return a replacement.
 *
 *   await updateGltf(bytes, (gltf) => {
 *     gltf.nodes.find((n) => n.name === 'Door').extras = { locked: true };
 *   });
 */
export async function updateGltf(glbBytes, fn) {
  const glb = readGlb(glbBytes);
  glb.json = (await fn(glb.json)) ?? glb.json;
  return writeGlb(glb);
}

/** Convenience: set `extras` on nodes by name. Returns new GLB bytes. */
export function setNodeExtras(glbBytes, extrasByName) {
  return updateGltf(glbBytes, (gltf) => {
    const missing = new Set(Object.keys(extrasByName));
    for (const node of gltf.nodes ?? []) {
      if (node.name in extrasByName) {
        node.extras = { ...node.extras, ...extrasByName[node.name] };
        missing.delete(node.name);
      }
    }
    if (missing.size) throw new Error(`No glTF node named: ${[...missing].join(', ')}`);
  });
}

/** Read `extras` for every named node: { [name]: extras }. */
export function getNodeExtras(glbBytes) {
  const out = {};
  for (const node of readGlb(glbBytes).json.nodes ?? []) {
    if (node.name && node.extras) out[node.name] = node.extras;
  }
  return out;
}
