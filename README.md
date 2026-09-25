# scenefile — `.scene.png` and `.scene.glb`

Save an app's editable scene or workspace *inside* an image or 3D model, the way
`.excalidraw.png` does. The files still work as a normal image or model:

| Extension     | Opens as                                 | Where the scene data lives |
|---------------|------------------------------------------|----------------------------|
| `.scene.png`  | a normal PNG (any viewer, browser, editor) | a zlib-compressed `iTXt` chunk, keyword `application/vnd.scenefile+json` |
| `.scene.glb`  | a normal glTF 2.0 binary (three.js, Blender, Babylon, model-viewer…) | an extra GLB chunk of type `SCNE` holding a `.blend`-style set of data blocks, plus optional per-node `extras` |

Double-click `drawing.scene.png` and you see the picture. Drop it back into your
app and you get the full editable scene: layers, camera, element list, and anything
else you store.
`model.scene.glb` loads as a model everywhere. Your editor also gets back
everything glTF can't express, much like a `.blend` file stores it (see
[GLB scene documents](#glb-scene-documents-blend-style)):

- scene settings (frame range, fps, units, render and world settings)
- collections and visibility flags
- modifier and constraint stacks
- shader node graphs
- timeline markers
- viewports, selection and the 3D cursor
- undo history, text blocks and a thumbnail

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

# GLB scene documents
npx scenefile outline model.scene.glb             # outliner-style tree (below)
npx scenefile validate model.scene.glb            # broken references, bad frame ranges, …
npx scenefile doc-export model.scene.glb -o doc.json
npx scenefile doc-import model.glb doc.json       # -> model.scene.glb (validated first)
npx scenefile thumbnail model.glb preview.png     # set the thumbnail
npx scenefile thumbnail model.scene.glb -o preview.png
```

```
$ npx scenefile outline examples/out/sample.scene.glb
Scene "Scene" · frames 1–120 @ 30 fps · camera: Camera
└─ Root (empty)
   ├─ Triangle (mesh) [Props] {active, 2 modifiers}
   ├─ Camera (camera) [Rig]
   └─ Lamp (light) [Rig] {hidden}
Collections:
  Props (1 object)
  Rig (2 objects)
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
`readSceneBlocks`, `writeSceneBlocks`, `listSceneBlocks`, `readChunks`, `writeChunks`.

## GLB scene documents (.blend-style)

glTF stores the *exported* scene: nodes, meshes, PBR materials, cameras, lights and
animations. A `.blend` file keeps more than that. `SceneGlb` stores the rest as named
blocks in the `SCNE` chunk and links them to glTF nodes, materials and animations by
index:

| Block         | What it holds (like in Blender) |
|---------------|---------------------------------|
| `scene`       | name, frame range / current frame, fps, active camera, up axis, units, gravity, render settings (engine, resolution, samples, output), world (color, HDRI, strength), color management |
| `collections` | collection tree (`parent`), color tag, viewport/render/select visibility, linked objects |
| `objects`     | per-node editor data: `hideViewport`, `hideRender`, `hideSelect`, `locked`, `modifiers[]`, `constraints[]`, custom `properties`, extra `camera` / `light` settings (DOF, sensor, shadow softness…), `notes` |
| `materials`   | per-material shader `nodeGraph` (`nodes[]`, `links[]`) and anything else your editor needs |
| `animation`   | timeline `markers[]`, per-animation `actions` (frame range, loop mode…), playback settings |
| `editor`      | mode, selection, active object, 3D cursor, saved viewports (camera, projection, shading, overlays), current tool, tool settings, workspace |
| `history`     | undo steps (`entries[]`, trimmed to `limit`) |
| `texts`       | text blocks: notes, scripts (`{ "notes.md": "…" }`) |
| `thumbnail`   | PNG preview image (binary, stored uncompressed) |
| `data`        | the free-form object used by `embed()` / `extract()` |
| *anything*    | your own JSON or binary blocks via `setBlock(name, value)` |

Every section loads with defaults filled in, so a plain `.glb` opens as a complete
document. Unknown fields are kept, so you can add your own.

```js
import { SceneGlb } from 'scenefile';

const doc = await SceneGlb.load(glbBytes);        // .glb or .scene.glb

doc.scene.fps = 30;
doc.scene.render.resolution = [1280, 720];

const door = doc.object('Door');                  // by node name or index
door.modifiers.push({ type: 'bevel', width: 0.02 });
door.properties.locked = true;
doc.object('Lamp').hideRender = true;

doc.collection('Props', { color: 'orange' });
doc.link('Props', 'Door', 'Table');

doc.material('Wood').nodeGraph = { nodes: [...], links: [...] };
doc.action('Walk').loop = 'pingpong';
doc.addMarker('impact', 60);

doc.select(['Door'], { active: 'Door' });
doc.editor.cursor.location = [0, 1, 0];
doc.addViewport({ position: [3, 2, 5], target: [0, 0, 0], fov: 50, shading: 'material' });
doc.pushHistory('Add bevel', { object: 'Door' });
doc.texts['notes.md'] = 'fix UVs';
doc.thumbnail = pngBytes;
doc.setBlock('my-editor', { snapping: { increment: 0.25 } });

doc.outline();    // text tree, as in the CLI
doc.summary();    // counts: nodes, meshes, triangles, materials, lights, …
doc.validate();   // [{ level: 'error' | 'warning', message }]

const bytes = await doc.save({ generator: 'My Editor 1.0' });
```

`doc.gltf` is the live glTF JSON if you need to change the model data too.

**Keeping references valid.** Records remember the name of the node or material
they belong to. If the glTF JSON is edited so indices shift (for example with
`updateGltf`), `load()` finds each node again by name. It then updates the objects,
collections, selection, active object and active camera to match, and lists what
it fixed in `doc.loadWarnings`.

### PNG envelope

In a PNG, your data is wrapped so later versions can migrate it:

```json
{ "format": "scenefile", "version": 1, "kind": "png", "savedAt": "2026-…", "data": { /* yours */ } }
```

`extractEnvelope(bytes)` returns the whole envelope. `extract(bytes)` returns only `data`.
For GLBs the same functions read the `data` block.

### GLB `SCNE` chunk layout (version 2)

```
"SCF2"        4-byte magic
uint32 LE     header length
header        UTF-8 JSON, space-padded to 4 bytes:
              { format, version: 2, savedAt, generator,
                blocks: [{ name, type: "json"|"binary", mime?, compression: "zlib"|"none",
                           offset, length, rawLength }] }
payload       block bytes at the listed offsets (each block compressed on its own)
```

You can list blocks without decompressing anything (`listSceneBlocks`). Version 1
files (a single zlib JSON blob) are still read, and are saved as version 2.

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
