// Tiny in-memory PNG and GLB builders so tests need no binary fixtures.

import { writeChunks } from '../src/png.js';
import { writeGlb } from '../src/glb.js';
import { concat, deflate } from '../src/util.js';

/** A width x height RGBA PNG filled with a gradient. */
export async function makePng(width = 16, height = 16) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filter, no interlace
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(1 + width * 4); // filter byte 0
    for (let x = 0; x < width; x++) row.set([(x * 255) / (width - 1), (y * 255) / (height - 1), 128, 255], 1 + x * 4);
    rows.push(row);
  }
  return writeChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: await deflate(concat(rows)) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
}

/**
 * A small but complete scene: a triangle mesh with a material and an
 * animation, a camera and a KHR_lights_punctual light, under a Root node.
 */
export function makeGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 1, 0, 0, 2, 0]);
  const bin = concat([positions, times, translations].map((a) => new Uint8Array(a.buffer)));
  const json = {
    asset: { version: '2.0', generator: 'scenefile-test' },
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [{ name: 'Sun', type: 'directional', intensity: 3 }] } },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'Root', children: [1, 2, 3] },
      { name: 'Triangle', mesh: 0, translation: [0, 1, 0] },
      { name: 'Camera', camera: 0, translation: [0, 1, 5] },
      { name: 'Lamp', extensions: { KHR_lights_punctual: { light: 0 } }, rotation: [-0.383, 0, 0, 0.924] },
    ],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Wood', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.4, 0.2, 1], metallicFactor: 0 } }],
    cameras: [{ name: 'Cam', type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }],
    animations: [
      {
        name: 'Bounce',
        channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
        samplers: [{ input: 1, output: 2 }],
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGlb({ json, chunks: [{ type: 0x004e4942, data: bin }] });
}
