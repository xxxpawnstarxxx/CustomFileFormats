import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHUNK_SCENE,
  decodeBlocks,
  embed,
  encodeBlocks,
  extract,
  listSceneBlocks,
  readGlb,
  SceneGlb,
  updateGltf,
  writeGlb,
} from '../src/index.js';
import { concat, deflate, encodeText } from '../src/util.js';
import { makeGlb, makePng } from './fixtures.js';

async function buildDoc() {
  const doc = await SceneGlb.load(makeGlb());
  Object.assign(doc.scene, { fps: 30, frameEnd: 120 });
  doc.scene.render.resolution = [1280, 720];
  doc.scene.world.color = [0.1, 0.2, 0.3];

  const tri = doc.object('Triangle');
  tri.modifiers.push({ type: 'subdivision', levels: 2 }, { type: 'bevel', width: 0.02, enabled: false });
  tri.properties.health = 3;
  doc.object('Lamp').hideRender = true;
  doc.object('Camera').camera = { focusDistance: 5, fStop: 2.8 };

  doc.collection('Props', { color: 'orange' });
  doc.collection('Lighting', { parent: 'Props', hideViewport: true });
  doc.link('Props', 'Triangle');
  doc.link('Lighting', 'Lamp', 'Camera');

  doc.material('Wood').nodeGraph = {
    nodes: [{ id: 'n1', type: 'noise', scale: 4 }, { id: 'out', type: 'principled' }],
    links: [{ from: ['n1', 'color'], to: ['out', 'baseColor'] }],
  };
  doc.action('Bounce').loop = 'pingpong';
  doc.addMarker('impact', 60);
  doc.addMarker('start', 1);
  doc.select(['Triangle', 'Camera'], { active: 'Triangle' });
  doc.editor.cursor.location = [1, 2, 3];
  doc.addViewport({ position: [4, 3, 6], target: [0, 0, 0], fov: 50, shading: 'material' });
  doc.pushHistory('Add subdivision', { object: 1 });
  doc.texts['notes.md'] = '# TODO\nfix UVs';
  doc.thumbnail = await makePng(8, 8);
  doc.setBlock('myplugin', { enabled: true });
  doc.setBlock('bake', new Uint8Array([1, 2, 3, 4, 5]), { mime: 'application/octet-stream' });
  return doc;
}

test('scene doc: every section round-trips through save/load', async () => {
  const doc = await buildDoc();
  const bytes = await doc.save();
  const again = await SceneGlb.load(bytes);

  assert.deepEqual(again.toJSON(), doc.toJSON());
  assert.equal(again.scene.fps, 30);
  assert.deepEqual(again.scene.render.resolution, [1280, 720]);
  assert.equal(again.scene.render.resolutionScale, 1, 'defaults fill in unset fields');
  assert.equal(again.object('Triangle').modifiers[1].type, 'bevel');
  assert.deepEqual(again.collectionsOf('Lamp'), ['Lighting']);
  assert.deepEqual(again.editor.selection, [1, 2]);
  assert.equal(again.editor.activeObject, 1);
  assert.deepEqual(again.animation.markers.map((m) => m.name), ['start', 'impact']);
  assert.equal(again.material(0).nodeGraph.nodes.length, 2);
  assert.deepEqual([...again.thumbnail], [...doc.thumbnail]);
  assert.deepEqual(again.getBlock('myplugin'), { enabled: true });
  assert.deepEqual([...again.getBlock('bake')], [1, 2, 3, 4, 5]);
  assert.ok(again.header.savedAt);
  assert.deepEqual(again.validate(), []);
  assert.deepEqual(again.loadWarnings, []);

  // The model itself is unchanged.
  assert.deepEqual(readGlb(bytes).json.nodes, readGlb(makeGlb()).json.nodes);
  const names = listSceneBlocks(bytes).map((b) => b.name);
  for (const n of ['scene', 'objects', 'collections', 'editor', 'thumbnail', 'myplugin', 'bake']) assert.ok(names.includes(n), n);
  assert.equal(listSceneBlocks(bytes).find((b) => b.name === 'thumbnail').compression, 'none');
});

test('scene doc: plain GLB gets defaults derived from the glTF', async () => {
  const doc = await SceneGlb.load(makeGlb());
  assert.equal(doc.header, null);
  assert.equal(doc.scene.name, 'Scene');
  assert.equal(doc.scene.activeCamera, 2);
  assert.equal(doc.nodeKind('Triangle'), 'mesh');
  assert.equal(doc.nodeKind('Lamp'), 'light');
  assert.equal(doc.nodeKind('Root'), 'empty');
  assert.deepEqual(doc.summary().counts.triangles, 1);
  assert.deepEqual(doc.summary().counts.lights, 1);
});

test('scene doc: coexists with free-form embed()/extract()', async () => {
  const withData = await embed(makeGlb(), { hello: 'world' });
  const doc = await SceneGlb.load(withData);
  assert.deepEqual(doc.data, { hello: 'world' });
  doc.scene.fps = 60;
  const saved = await doc.save();
  assert.deepEqual(await extract(saved), { hello: 'world' });

  const reembedded = await embed(saved, { hello: 'again' });
  assert.equal((await SceneGlb.load(reembedded)).scene.fps, 60, 'embed() keeps the other blocks');
  assert.deepEqual(await extract(reembedded), { hello: 'again' });
});

test('scene doc: reads version 1 files', async () => {
  const env = { format: 'scenefile', version: 1, kind: 'glb', savedAt: '2026-01-01T00:00:00Z', data: { old: true } };
  const z = await deflate(encodeText(JSON.stringify(env)));
  const chunk = new Uint8Array(4 + z.length);
  new DataView(chunk.buffer).setUint32(0, z.length, true);
  chunk.set(z, 4);
  const glb = readGlb(makeGlb());
  glb.chunks.push({ type: CHUNK_SCENE, data: chunk });
  const legacy = writeGlb(glb);

  assert.deepEqual(await extract(legacy), { old: true });
  const doc = await SceneGlb.load(legacy);
  assert.deepEqual(doc.data, { old: true });
  assert.equal(doc.header.version, 1);
  const upgraded = await doc.save();
  assert.equal(listSceneBlocks(upgraded).find((b) => b.name === 'data').type, 'json');
  assert.deepEqual(await extract(upgraded), { old: true });
});

test('scene doc: references follow nodes when the glTF is reordered', async () => {
  const saved = await (await buildDoc()).save();
  // Reverse the Root's children order in the node array: [Root, Lamp, Camera, Triangle].
  const edited = await updateGltf(saved, (g) => {
    const [root, tri, cam, lamp] = g.nodes;
    g.nodes = [root, lamp, cam, tri];
    root.children = [3, 2, 1];
    g.animations[0].channels[0].target.node = 3;
  });
  const doc = await SceneGlb.load(edited);
  assert.equal(doc.object('Triangle').modifiers.length, 2);
  assert.equal(doc.object('Lamp').hideRender, true);
  assert.deepEqual(doc.collectionsOf('Triangle'), ['Props']);
  assert.deepEqual(doc.editor.selection, [3, 2]);
  assert.equal(doc.editor.activeObject, 3);
  assert.equal(doc.scene.activeCamera, 2);
  assert.equal(doc.loadWarnings.length, 2);
  assert.deepEqual(doc.validate(), []);
});

test('scene doc: validate reports broken references and settings', async () => {
  const doc = await SceneGlb.load(makeGlb());
  doc.scene.fps = 0;
  doc.scene.frameEnd = -5;
  doc.scene.activeCamera = 1;
  doc.editor.selection = [99];
  doc.objects[42] = { name: 'Ghost' };
  doc.object('Triangle').modifiers.push({ levels: 2 });
  doc.collection('A', { parent: 'B' });
  doc.collection('B', { parent: 'A' });
  doc.collections.push({ name: 'A', parent: null, objects: [7] });
  const messages = doc.validate().map((i) => `${i.level}: ${i.message}`);
  for (const expected of [
    'error: scene.fps must be positive',
    'error: scene.frameEnd',
    'warning: scene.activeCamera node "Triangle" has no camera',
    'error: editor.selection contains missing node 99',
    'error: objects[42] points to a missing node',
    'error: objects[1].modifiers[0] has no type',
    'error: Duplicate collection name "A"',
    'error: Collection "A" is part of a parent cycle',
    'error: Collection "A" links missing node 7',
  ]) {
    assert.ok(messages.some((m) => m.startsWith(expected)), `missing: ${expected}\n${messages.join('\n')}`);
  }
});

test('scene doc: outline shows hierarchy, collections and flags', async () => {
  const text = (await buildDoc()).outline();
  assert.match(text, /^Scene "Scene" · frames 1–120 @ 30 fps · camera: Camera/);
  assert.match(text, /└─ Root \(empty\)/);
  assert.match(text, /├─ Triangle \(mesh\) \[Props\] \{active, 2 modifiers\}/);
  assert.match(text, /├─ Camera \(camera\) \[Lighting\] \{selected\}/);
  assert.match(text, /└─ Lamp \(light\) \[Lighting\] \{no-render\}/);
  assert.match(text, /Collections:\n {2}Props \(1 object\)\n {4}Lighting \(2 objects\) \{hidden\}/);
});

test('scene doc: history limit, reserved blocks, bad lookups', async () => {
  const doc = await SceneGlb.load(makeGlb());
  doc.history.limit = 3;
  for (let i = 0; i < 5; i++) doc.pushHistory(`step ${i}`);
  assert.deepEqual(doc.history.entries.map((e) => e.label), ['step 2', 'step 3', 'step 4']);
  assert.throws(() => doc.setBlock('scene', {}), /built-in block/);
  assert.throws(() => doc.object('Nope'), /No glTF node "Nope"/);
  assert.throws(() => doc.material(5), /No glTF material 5/);
  assert.throws(() => { doc.thumbnail = new Uint8Array([1, 2, 3]); }, /must be a PNG/);
});

test('scene doc: toJSON/applyJSON edits sections without touching others', async () => {
  const doc = await buildDoc();
  const json = doc.toJSON();
  const fresh = await SceneGlb.load(await doc.save());
  fresh.applyJSON({ scene: { fps: 12 }, blocks: { extra: [1, 2] } });
  assert.equal(fresh.scene.fps, 12);
  assert.equal(fresh.scene.frameEnd, 250, 'a partial section is filled from defaults');
  assert.deepEqual(fresh.collections, json.collections);
  assert.deepEqual(fresh.getBlock('extra'), [1, 2]);
});

test('block container: integrity checks', async () => {
  const blocks = new Map([['a', { type: 'json', value: { x: 1 } }]]);
  const data = await encodeBlocks(blocks);
  assert.deepEqual((await decodeBlocks(data)).blocks.get('a').value, { x: 1 });
  await assert.rejects(() => decodeBlocks(data.subarray(0, data.length - 2)), /truncated/);

  const future = concat([encodeText('SCF2'), new Uint8Array([0, 0, 0, 0])]);
  const header = encodeText(JSON.stringify({ format: 'scenefile', version: 99, blocks: [] }));
  new DataView(future.buffer).setUint32(4, header.length, true);
  await assert.rejects(() => decodeBlocks(concat([future, header])), /newer than supported/);
});
