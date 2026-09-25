// scenefile — store editable scene/workspace data inside files that still
// open as ordinary images (.scene.png) and 3D models (.scene.glb).

import { embedGlb, extractGlb, extractGlbEnvelope, isGlb, stripGlb } from './glb.js';
import { embedPng, extractPng, extractPngEnvelope, isPng, stripPng } from './png.js';
import { toBytes } from './util.js';

export * from './png.js';
export * from './glb.js';
export * from './scene-doc.js';
export { BLOCKS_VERSION, decodeBlocks, encodeBlocks, readBlocksHeader } from './blocks.js';
export { FORMAT, FORMAT_VERSION } from './util.js';

export const EXTENSIONS = { png: '.scene.png', glb: '.scene.glb' };

/** Detect the container type from the file's magic bytes: 'png' | 'glb' | null. */
export function detect(bytes) {
  bytes = toBytes(bytes);
  if (isPng(bytes)) return 'png';
  if (isGlb(bytes)) return 'glb';
  return null;
}

function dispatch(bytes, handlers) {
  const kind = detect(bytes);
  if (!kind) throw new Error('Unsupported file: expected a PNG or GLB');
  return handlers[kind](bytes);
}

/** Embed scene data into a PNG or GLB (auto-detected). */
export const embed = (bytes, data) =>
  dispatch(bytes, { png: (b) => embedPng(b, data), glb: (b) => embedGlb(b, data) });

/** Extract scene data from a PNG or GLB, or null if none is embedded. */
export const extract = (bytes) => dispatch(bytes, { png: extractPng, glb: extractGlb });

/** Extract the full versioned envelope, or null. */
export const extractEnvelope = (bytes) => dispatch(bytes, { png: extractPngEnvelope, glb: extractGlbEnvelope });

/** Remove scene data, returning a plain PNG/GLB. */
export const strip = (bytes) => dispatch(bytes, { png: stripPng, glb: stripGlb });

/** Suggested output name: "photo.png" -> "photo.scene.png". */
export function sceneFileName(name) {
  return name.replace(/(\.scene)?\.(png|glb)$/i, (_, __, ext) => `.scene.${ext.toLowerCase()}`);
}
