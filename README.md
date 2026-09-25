# scenefile — `.scene.png` and `.scene.glb`

Save an app's editable scene or workspace *inside* an image or 3D model, the way
`.excalidraw.png` does. The files still work as a normal image or model:

| Extension     | Opens as                                 | Where the scene data lives |
|---------------|------------------------------------------|----------------------------|
| `.scene.png`  | a normal PNG (any viewer, browser, editor) | a zlib-compressed `iTXt` chunk, keyword `application/vnd.scenefile+json` |
| `.scene.glb`  | a normal glTF 2.0 binary (three.js, Blender, Babylon, model-viewer…) | an extra GLB chunk of type `SCNE` (zlib-compressed JSON), plus optional per-node `extras` |

Double-click `drawing.scene.png` and you see the picture. Drop it back into your
app and you get the full editable scene: layers, camera, element list, and anything
else you store.
`model.scene.glb` loads as a model everywhere. Your editor can also read the extra
data it saved in the file, such as the editor camera, selection, node graphs,
undo history and tool settings, the way a `.blend` file keeps them.

Zero dependencies. Works in Node ≥ 18 and modern browsers (uses `CompressionStream`).

## Why it stays a valid file

- **PNG**: `iTXt` is a standard ancillary chunk. Decoders skip ancillary chunks they
  don't need, so pixels are never touched. The scene chunk sits before `IDAT`.
- **GLB**: the glTF 2.0 spec says *"client implementations must ignore chunks with
  unknown types."* The file keeps `JSON` first and `BIN` second, and appends `SCNE`
  after them with 4-byte alignment. The Khronos glTF-Validator reports 0 errors. Its only
  warning is `GLB_UNKNOWN_CHUNK_TYPE`, which is expected. A small marker is also written
  to `asset.extras.scenefile`.
- **Per-node data** (`setNodeExtras`) goes in standard glTF `nodes[i].extras`.
  three.js exposes it as `object.userData`, and Blender imports it as custom properties.

## CLI

```sh
npx scenefile embed photo.png scene.json          # -> photo.scene.png
npx scenefile embed model.glb scene.json          # -> model.scene.glb
npx scenefile extract photo.scene.png             # prints the scene JSON
npx scenefile extract model.scene.glb -o scene.json
npx scenefile info model.scene.glb
npx scenefile strip photo.scene.png               # -> photo.png (plain)
npx scenefile node-extras model.glb extras.json   # {"Door": {"locked": true}}
```

## API

```js
import { embed, extract, strip, detect, setNodeExtras, getNodeExtras } from 'scenefile';

// Save: bytes in, bytes out (Uint8Array / Buffer / ArrayBuffer accepted).
const scenePng = await embed(pngBytes, { camera, layers, elements });
const sceneGlb = await embed(glbBytes, { editorCamera, selection, nodeGraph });

// Load: returns your object, or null for an ordinary PNG/GLB with no scene.
const scene = await extract(fileBytes);

// Per-node data inside the glTF itself (visible to other tools).
const tagged = await setNodeExtras(glbBytes, { Door: { locked: true, key: 'red' } });
getNodeExtras(tagged); // { Door: { locked: true, key: 'red' } }
```

Browser example, saving from a `<canvas>`:

```js
const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r))).arrayBuffer());
const file = new Blob([await embed(png, scene)], { type: 'image/png' });
// download as `drawing.scene.png`
```

Format-specific functions are also exported: `embedPng`, `extractPng`, `stripPng`,
`embedGlb`, `extractGlb`, `stripGlb`, `updateGltf`, `readGlb`, `writeGlb`,
`readChunks`, `writeChunks`.

### Stored envelope

Your data is wrapped so later versions can migrate it:

```json
{ "format": "scenefile", "version": 1, "kind": "png", "savedAt": "2026-…", "data": { /* yours */ } }
```

`extractEnvelope(bytes)` returns the whole envelope. `extract(bytes)` returns only `data`.

### GLB `SCNE` chunk layout

```
uint32 LE  compressedLength
bytes      zlib(JSON envelope)      // compressedLength bytes
bytes      zero padding to 4-byte alignment
```

## Caveats

- Tools that **re-encode** the file drop the scene data. For PNGs that means editors,
  "optimizers" and many social/chat uploads. For GLBs it means re-exporting from
  Blender or passing the file through gltf-transform. Per-node `extras` generally
  survive a Blender round-trip. The `SCNE` chunk does not.
- Re-embedding replaces the existing scene. It never duplicates it.

## Development

```sh
npm test          # node:test suite
npm run samples   # writes examples/out/sample.scene.{png,glb}
```
