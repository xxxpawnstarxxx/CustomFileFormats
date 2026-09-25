import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHUNK_SCENE,
  detect,
  embed,
  extract,
  extractEnvelope,
  getNodeExtras,
  readChunks,
  readGlb,
  sceneFileName,
  setNodeExtras,
  strip,
} from '../src/index.js';
import { makeGlb, makePng } from './fixtures.js';

const scene = {
  camera: { x: 12, y: -4, zoom: 1.5 },
  layers: [{ id: 'bg', visible: true }, { id: 'ink', visible: false }],
  elements: Array.from({ length: 50 }, (_, i) => ({ id: `el${i}`, type: 'rect', x: i, y: i * 2, label: 'héllo ✏️' })),
};

test('png: embed/extract round-trips and keeps pixel data identical', async () => {
  const png = await makePng();
  const out = await embed(png, scene);
  assert.equal(detect(out), 'png');
  assert.deepEqual(await extract(out), scene);

  const idat = (bytes) => readChunks(bytes).filter((c) => c.type === 'IDAT').map((c) => [...c.data]);
  assert.deepEqual(idat(out), idat(png));
  assert.equal(readChunks(out)[0].type, 'IHDR');
  assert.equal(readChunks(out).at(-1).type, 'IEND');
});

test('png: re-embedding replaces instead of duplicating', async () => {
  const once = await embed(await makePng(), scene);
  const twice = await embed(once, { v: 2 });
  assert.deepEqual(await extract(twice), { v: 2 });
  assert.equal(readChunks(twice).filter((c) => c.type === 'iTXt').length, 1);
});

test('png: strip and plain files', async () => {
  const png = await makePng();
  assert.equal(await extract(png), null);
  const stripped = await strip(await embed(png, scene));
  assert.deepEqual([...stripped], [...png]);
});

test('png: corrupted CRC is rejected', async () => {
  const out = await embed(await makePng(), scene);
  out[40] ^= 0xff;
  await assert.rejects(() => extract(out), /Bad CRC/);
});

test('glb: embed/extract round-trips and keeps the model intact', async () => {
  const glb = makeGlb();
  const out = await embed(glb, scene);
  assert.equal(detect(out), 'glb');
  assert.deepEqual(await extract(out), scene);

  const before = readGlb(glb);
  const after = readGlb(out);
  // BIN stays the second chunk, geometry bytes unchanged, SCNE comes after.
  assert.equal(after.chunks[0].type, 0x004e4942);
  assert.deepEqual([...after.chunks[0].data], [...before.chunks[0].data]);
  assert.equal(after.chunks[1].type, CHUNK_SCENE);
  assert.deepEqual(after.json.nodes, before.json.nodes);
  assert.deepEqual(after.json.asset.extras.scenefile, { chunk: 'SCNE', encoding: 'scenefile-blocks', version: 2 });

  // Header length matches and every chunk is 4-byte aligned.
  const view = new DataView(out.buffer, out.byteOffset);
  assert.equal(view.getUint32(8, true), out.length);
  for (let pos = 12; pos < out.length; pos += 8 + view.getUint32(pos, true)) {
    assert.equal(view.getUint32(pos, true) % 4, 0);
  }
});

test('glb: re-embed, strip, envelope', async () => {
  const glb = makeGlb();
  const twice = await embed(await embed(glb, scene), { v: 2 });
  assert.equal(readGlb(twice).chunks.filter((c) => c.type === CHUNK_SCENE).length, 1);
  const env = await extractEnvelope(twice);
  assert.equal(env.kind, 'glb');
  assert.equal(env.version, 2);
  assert.deepEqual(env.data, { v: 2 });
  assert.deepEqual([...(await strip(twice))], [...glb]);
});

test('glb: per-node extras', async () => {
  const out = await setNodeExtras(makeGlb(), { Triangle: { material: 'wood', health: 3 } });
  assert.deepEqual(getNodeExtras(out), { Triangle: { material: 'wood', health: 3 } });
  await assert.rejects(() => setNodeExtras(out, { Nope: {} }), /No glTF node named: Nope/);
});

test('rejects unsupported files and names outputs', async () => {
  await assert.rejects(async () => embed(new Uint8Array([1, 2, 3]), {}), /Unsupported file/);
  assert.equal(sceneFileName('photo.png'), 'photo.scene.png');
  assert.equal(sceneFileName('Model.GLB'), 'Model.scene.glb');
  assert.equal(sceneFileName('a.scene.png'), 'a.scene.png');
});
