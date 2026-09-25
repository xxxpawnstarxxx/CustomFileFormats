// Generates examples/out/sample.scene.png and sample.scene.glb from scratch.
//   npm run samples

import { mkdir, writeFile } from 'node:fs/promises';
import { embed, setNodeExtras } from '../src/index.js';
import { makeGlb, makePng } from '../test/fixtures.js';

const outDir = new URL('./out/', import.meta.url);
await mkdir(outDir, { recursive: true });

const png = await embed(await makePng(64, 64), {
  app: 'my-drawing-app',
  camera: { x: 0, y: 0, zoom: 1 },
  elements: [{ id: 'r1', type: 'rect', x: 8, y: 8, w: 48, h: 48, stroke: '#222' }],
});
await writeFile(new URL('sample.scene.png', outDir), png);

let glb = await setNodeExtras(makeGlb(), { Triangle: { material: 'wood', clickable: true } });
glb = await embed(glb, {
  app: 'my-3d-editor',
  editorCamera: { position: [3, 2, 5], target: [0, 0, 0], fov: 50 },
  selection: ['Triangle'],
  nodeGraph: { nodes: [{ id: 'n1', op: 'noise', scale: 4 }], links: [] },
  undoHistory: [],
});
await writeFile(new URL('sample.scene.glb', outDir), glb);

console.log('Wrote examples/out/sample.scene.png and examples/out/sample.scene.glb');
