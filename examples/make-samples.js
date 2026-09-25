// Generates example files in examples/out/:
//   sample.scene.png   image with an embedded drawing scene
//   sample.scene.glb   model with a full .blend-style scene document
//   npm run samples

import { mkdir, writeFile } from 'node:fs/promises';
import { embed, SceneGlb, setNodeExtras } from '../src/index.js';
import { makeGlb, makePng } from '../test/fixtures.js';

const outDir = new URL('./out/', import.meta.url);
await mkdir(outDir, { recursive: true });

const png = await embed(await makePng(64, 64), {
  app: 'my-drawing-app',
  camera: { x: 0, y: 0, zoom: 1 },
  elements: [{ id: 'r1', type: 'rect', x: 8, y: 8, w: 48, h: 48, stroke: '#222' }],
});
await writeFile(new URL('sample.scene.png', outDir), png);

// Per-node extras are part of the glTF itself: three.js userData, Blender custom properties.
const doc = await SceneGlb.load(await setNodeExtras(makeGlb(), { Triangle: { clickable: true } }));

Object.assign(doc.scene, { fps: 30, frameEnd: 120 });
doc.scene.render = { ...doc.scene.render, engine: 'cycles', samples: 256, resolution: [1280, 720] };
doc.scene.world = { color: [0.02, 0.03, 0.05], strength: 0.8, environmentMap: 'studio.hdr' };

const tri = doc.object('Triangle');
tri.modifiers.push({ type: 'subdivision', name: 'Subdiv', levels: 2 }, { type: 'bevel', name: 'Bevel', width: 0.02 });
tri.properties = { health: 3, team: 'blue' };
doc.object('Camera').camera = { focusDistance: 5, fStop: 2.8, sensorWidth: 36 };
doc.object('Lamp').light = { shadowSoftness: 0.2, castShadows: true };
doc.object('Lamp').hideViewport = true;

doc.collection('Props', { color: 'orange' });
doc.collection('Rig', { color: 'blue' });
doc.link('Props', 'Triangle');
doc.link('Rig', 'Camera', 'Lamp');

doc.material('Wood').nodeGraph = {
  nodes: [
    { id: 'noise', type: 'NoiseTexture', scale: 4, location: [-300, 0] },
    { id: 'ramp', type: 'ColorRamp', stops: [[0, '#5a3a1a'], [1, '#a0703a']], location: [-100, 0] },
    { id: 'bsdf', type: 'PrincipledBSDF', roughness: 0.6, location: [150, 0] },
  ],
  links: [
    { from: ['noise', 'Fac'], to: ['ramp', 'Fac'] },
    { from: ['ramp', 'Color'], to: ['bsdf', 'Base Color'] },
  ],
};

doc.action('Bounce').loop = 'pingpong';
doc.addMarker('start', 1);
doc.addMarker('impact', 60);

doc.select(['Triangle'], { active: 'Triangle' });
doc.editor.cursor.location = [0, 0.5, 0];
doc.addViewport({ name: 'Main', position: [3, 2, 5], target: [0, 0.5, 0], fov: 50, shading: 'material' });
doc.addViewport({ name: 'Top', projection: 'orthographic', position: [0, 10, 0], target: [0, 0, 0], shading: 'wireframe' });
doc.pushHistory('Add Subdivision modifier', { object: 'Triangle' });
doc.pushHistory('Link to Props', { object: 'Triangle', collection: 'Props' });
doc.texts['notes.md'] = '# Notes\n- fix UVs on Triangle\n';
doc.thumbnail = await makePng(32, 32);
doc.setBlock('my-editor', { snapping: { enabled: true, increment: 0.25 }, recentFiles: [] });

await writeFile(new URL('sample.scene.glb', outDir), await doc.save({ generator: 'scenefile example' }));
console.log('Wrote examples/out/sample.scene.png and examples/out/sample.scene.glb');
