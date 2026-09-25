#!/usr/bin/env node
// scenefile CLI — embed / extract / strip scene data in PNG and GLB files.

import { readFile, writeFile } from 'node:fs/promises';
import { detect, embed, extractEnvelope, getNodeExtras, sceneFileName, setNodeExtras, strip } from '../src/index.js';

const USAGE = `Usage:
  scenefile embed <image.png|model.glb> <scene.json> [-o out]   Embed scene JSON (default out: *.scene.png / *.scene.glb)
  scenefile extract <file> [-o scene.json]                      Print or save the embedded scene JSON
  scenefile info <file>                                         Show what the file contains
  scenefile strip <file> [-o out]                               Remove embedded scene data
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
      const target = out ?? sceneFileName(file);
      await writeFile(target, await embed(bytes, await readJson(second)));
      console.error(`Wrote ${target}`);
      break;
    }
    case 'extract': {
      const env = await extractEnvelope(bytes);
      if (!env) throw new Error(`${file} has no embedded scene data`);
      if (out) {
        await writeFile(out, JSON.stringify(env.data, null, 2) + '\n');
        console.error(`Wrote ${out}`);
      } else print(env.data);
      break;
    }
    case 'info': {
      const env = await extractEnvelope(bytes);
      const info = { file, type: detect(bytes), bytes: bytes.length, hasScene: !!env };
      if (env) Object.assign(info, { formatVersion: env.version, savedAt: env.savedAt });
      if (info.type === 'glb') info.nodeExtras = getNodeExtras(bytes);
      print(info);
      break;
    }
    case 'strip': {
      const target = out ?? file.replace(/\.scene\.(png|glb)$/i, '.$1');
      await writeFile(target, await strip(bytes));
      console.error(`Wrote ${target}`);
      break;
    }
    case 'node-extras': {
      if (!second) return print(getNodeExtras(bytes));
      const target = out ?? file;
      await writeFile(target, await setNodeExtras(bytes, await readJson(second)));
      console.error(`Wrote ${target}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(`scenefile: ${err.message}`);
  process.exit(1);
});
