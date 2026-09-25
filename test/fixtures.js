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

/** A GLB containing one triangle mesh in a two-node hierarchy. */
export function makeGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(positions.buffer);
  const json = {
    asset: { version: '2.0', generator: 'scenefile-test' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'Root', children: [1] },
      { name: 'Triangle', mesh: 0, translation: [0, 1, 0] },
    ],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    buffers: [{ byteLength: bin.length }],
  };
  return writeGlb({ json, chunks: [{ type: 0x004e4942, data: bin }] });
}
