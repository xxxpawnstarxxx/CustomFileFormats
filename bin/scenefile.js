#!/usr/bin/env node
// scenefile CLI — embed / extract / inspect scene data in PNG and GLB files.

import { readFile, writeFile } from 'node:fs/promises';
import {
  detect,
  embed,
  extractEnvelope,
  getNodeExtras,
  listSceneBlocks,
  sceneFileName,
  SceneGlb,
  setNodeExtras,
  strip,
} from '../src/index.js';

const USAGE = `Usage:
  scenefile embed <image.png|model.glb> <scene.json> [-o out]   Embed free-form scene JSON (default out: *.scene.png / *.scene.glb)
  scenefile extract <file> [-o scene.json]                      Print or save the free-form scene JSON
  scenefile info <file>                                         Show what the file contains
  scenefile strip <file> [-o out]                               Remove embedded scene data

GLB scene document (.blend-style: scene settings, collections, objects, editor state, ...):
  scenefile outline <model.glb>                                 Print the scene tree, like Blender's outliner
  scenefile validate <model.glb>                                Check the scene document for broken references
  scenefile doc-export <model.glb> [-o doc.json]                Print or save every scene section as JSON
  scenefile doc-import <model.glb> <doc.json> [-o out]          Apply sections from JSON (default out: *.scene.glb)
  scenefile thumbnail <model.glb> [preview.png] [-o out]        Save the thumbnail (-o), or set it from a PNG
  scenefile node-extras <model.glb> [extras.json] [-o out]      Read, or set, per-node glTF extras ({ "NodeName": {...} })`;

function parseArgs(argv) {
  const positional = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') return { help: true };
    else positional.push(argv[i]);
  }
  return { positional, out };
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function loadDoc(file, bytes) {
  if (detect(bytes) !== 'glb') throw new Error(`${file} is not a GLB file`);
  const doc = await SceneGlb.load(bytes);
  for (const w of doc.loadWarnings) console.error(`warning: ${w}`);
  return doc;
}

async function save(target, bytes) {
  await writeFile(target, bytes);
  console.error(`Wrote ${target}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional = [], out, help } = parseArgs(rest);
  if (!command || help || command === 'help') return console.log(USAGE);

  const [file, second] = positional;
  if (!file) throw new Error(`Missing input file\n\n${USAGE}`);
  const bytes = await readFile(file);

  switch (command) {
    case 'embed': {
      if (!second) throw new Error('Missing scene JSON file');
      return save(out ?? sceneFileName(file), await embed(bytes, await readJson(second)));
    }
    case 'extract': {
      const env = await extractEnvelope(bytes);
      if (!env) throw new Error(`${file} has no free-form scene data (for GLB scene documents use doc-export)`);
      if (out) return save(out, JSON.stringify(env.data, null, 2) + '\n');
      return print(env.data);
    }
    case 'info': {
      const type = detect(bytes);
      const info = { file, type, bytes: bytes.length };
      if (type === 'glb') {
        const doc = await loadDoc(file, bytes);
        const blocks = listSceneBlocks(bytes);
        Object.assign(info, { hasScene: !!blocks, savedAt: doc.header?.savedAt ?? null, savedBy: doc.header?.generator ?? null, ...doc.summary() });
        if (blocks) info.blocks = blocks.map(({ name, type: t, mime, rawLength, length }) => ({ name, type: t, mime, rawLength, stored: length }));
        info.nodeExtras = getNodeExtras(bytes);
      } else {
        const env = await extractEnvelope(bytes);
        Object.assign(info, { hasScene: !!env, ...(env && { formatVersion: env.version, savedAt: env.savedAt }) });
      }
      return print(info);
    }
    case 'strip':
      return save(out ?? file.replace(/\.scene\.(png|glb)$/i, '.$1'), await strip(bytes));
    case 'outline':
      return console.log((await loadDoc(file, bytes)).outline());
    case 'validate': {
      const issues = (await loadDoc(file, bytes)).validate();
      for (const { level, message } of issues) console.log(`${level}: ${message}`);
      const errors = issues.filter((i) => i.level === 'error').length;
      console.log(errors ? `${errors} error(s)` : `OK${issues.length ? ` (${issues.length} warning(s))` : ''}`);
      if (errors) process.exitCode = 1;
      return;
    }
    case 'doc-export': {
      const json = JSON.stringify((await loadDoc(file, bytes)).toJSON(), null, 2) + '\n';
      return out ? save(out, json) : process.stdout.write(json);
    }
    case 'doc-import': {
      if (!second) throw new Error('Missing document JSON file');
      const doc = await loadDoc(file, bytes);
      doc.applyJSON(await readJson(second));
      const issues = doc.validate().filter((i) => i.level === 'error');
      if (issues.length) throw new Error(`Document has errors:\n  ${issues.map((i) => i.message).join('\n  ')}`);
      return save(out ?? sceneFileName(file), await doc.save());
    }
    case 'thumbnail': {
      const doc = await loadDoc(file, bytes);
      if (!second) {
        if (!doc.thumbnail) throw new Error(`${file} has no thumbnail`);
        if (!out) throw new Error('Use -o preview.png to save the thumbnail');
        return save(out, doc.thumbnail);
      }
      doc.thumbnail = await readFile(second);
      return save(out ?? sceneFileName(file), await doc.save());
    }
    case 'node-extras': {
      if (!second) return print(getNodeExtras(bytes));
      return save(out ?? file, await setNodeExtras(bytes, await readJson(second)));
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(`scenefile: ${err.message}`);
  process.exit(1);
});
