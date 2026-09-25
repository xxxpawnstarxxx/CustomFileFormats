// SceneGlb — a .blend-style scene document stored inside a .scene.glb.
//
// glTF already carries the "exported" scene: node hierarchy, meshes, PBR
// materials, cameras, lights, animations. A .blend file keeps much more:
// scene settings, collections, visibility flags, modifier stacks, shader node
// graphs, timeline markers, the editor's viewports, selection, 3D cursor,
// undo history, text blocks, and a thumbnail. SceneGlb stores all of that
// in named blocks inside the GLB's SCNE chunk, linked to glTF nodes and
// materials by index. The model still loads normally everywhere.
//
//   const doc = await SceneGlb.load(glbBytes);   // plain .glb works too
//   doc.scene.fps = 30;
//   doc.object('Door').modifiers.push({ type: 'bevel', width: 0.02 });
//   doc.link('Props', 'Door');
//   doc.select(['Door']);
//   const bytes = await doc.save();

import { readGlb, readSceneBlocks, setSceneChunk, writeGlb } from './glb.js';
import { isPng } from './png.js';
import { toBytes } from './util.js';

/** JSON sections, in the order they are written. */
export const SECTIONS = ['scene', 'collections', 'objects', 'materials', 'animation', 'editor', 'history', 'texts'];
const RESERVED = new Set([...SECTIONS, 'thumbnail', 'data']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

/** Merge stored values over defaults. Objects merge recursively; arrays and scalars replace. */
function withDefaults(defaults, stored) {
  if (!isPlainObject(defaults) || !isPlainObject(stored)) return stored === undefined ? defaults : stored;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(stored)) out[k] = withDefaults(defaults[k], v);
  return out;
}

function sectionDefaults(gltf) {
  const cameraNode = (gltf.nodes ?? []).findIndex((n) => n.camera !== undefined);
  return {
    scene: {
      name: gltf.scenes?.[gltf.scene ?? 0]?.name ?? 'Scene',
      frameStart: 1,
      frameEnd: 250,
      frameCurrent: 1,
      fps: 24,
      activeCamera: cameraNode === -1 ? null : cameraNode,
      upAxis: '+Y',
      units: { system: 'metric', scaleLength: 1, lengthUnit: 'meters' },
      gravity: [0, -9.81, 0],
      render: {
        engine: null,
        resolution: [1920, 1080],
        resolutionScale: 1,
        samples: null,
        transparentBackground: false,
        outputPath: null,
      },
      world: { color: [0.05, 0.05, 0.05], strength: 1, environmentMap: null },
      colorManagement: { viewTransform: 'Standard', look: null, exposure: 0, gamma: 1 },
    },
    collections: [],
    objects: {},
    materials: {},
    animation: { markers: [], actions: {}, playback: { loop: true, speed: 1 } },
    editor: {
      mode: 'object',
      selection: [],
      activeObject: null,
      cursor: { location: [0, 0, 0], rotation: [0, 0, 0, 1] },
      viewports: [],
      tool: null,
      toolSettings: {},
      workspace: null,
    },
    history: { entries: [], limit: 64 },
    texts: {},
  };
}

export class SceneGlb {
  #glb;
  #extra = new Map(); // custom and binary blocks, keyed by name
  /** Header of the loaded scene data (savedAt, generator, version), or null for a plain GLB. */
  header = null;
  /** Problems fixed automatically while loading (e.g. nodes renamed or removed). */
  loadWarnings = [];

  /** Open a .glb or .scene.glb. Plain GLBs start with default scene settings. */
  static async load(bytes) {
    const glb = readGlb(toBytes(bytes));
    return new SceneGlb(glb, await readSceneBlocks(glb));
  }

  constructor(glb, stored = null) {
    this.#glb = glb;
    const defaults = sectionDefaults(glb.json);
    const blocks = stored?.blocks ?? new Map();
    for (const name of SECTIONS) {
      this[name] = withDefaults(defaults[name], blocks.get(name)?.value);
    }
    for (const [name, block] of blocks) if (!SECTIONS.includes(name)) this.#extra.set(name, block);
    this.header = stored?.header ?? null;
    this.#reconcile();
  }

  /** The glTF JSON. Edit it directly; changes are written by save(). */
  get gltf() {
    return this.#glb.json;
  }

  // ---- lookups --------------------------------------------------------------

  /** Resolve a node by index or name to its index. */
  nodeIndex(ref) {
    const nodes = this.gltf.nodes ?? [];
    const i = typeof ref === 'number' ? ref : nodes.findIndex((n) => n.name === ref);
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length) throw new Error(`No glTF node ${JSON.stringify(ref)}`);
    return i;
  }

  /** Resolve a material by index or name to its index. */
  materialIndex(ref) {
    const materials = this.gltf.materials ?? [];
    const i = typeof ref === 'number' ? ref : materials.findIndex((m) => m.name === ref);
    if (!Number.isInteger(i) || i < 0 || i >= materials.length) {
      throw new Error(`No glTF material ${JSON.stringify(ref)}`);
    }
    return i;
  }

  /** What a node is in glTF terms: 'mesh' | 'camera' | 'light' | 'empty'. */
  nodeKind(ref) {
    const node = this.gltf.nodes[this.nodeIndex(ref)];
    if (node.mesh !== undefined) return 'mesh';
    if (node.camera !== undefined) return 'camera';
    if (node.extensions?.KHR_lights_punctual) return 'light';
    return 'empty';
  }

  // ---- objects & materials --------------------------------------------------

  /**
   * Editor data for a node, created on first access. Well-known fields:
   *   hideViewport, hideRender, hideSelect, locked   booleans
   *   modifiers    [{ type, name, enabled, ...params }]  non-destructive stack
   *   constraints  [{ type, target, ...params }]
   *   properties   { ... }   custom properties
   *   camera       { focusDistance, fStop, sensorWidth, ... } beyond glTF
   *   light        { shadowSoftness, castShadows, ... } beyond glTF
   *   notes        string
   * Any other fields are kept as-is.
   */
  object(ref) {
    const i = this.nodeIndex(ref);
    const record = (this.objects[i] ??= {});
    record.name = this.gltf.nodes[i].name ?? null;
    record.modifiers ??= [];
    record.constraints ??= [];
    record.properties ??= {};
    return record;
  }

  hasObject(ref) {
    return this.nodeIndex(ref) in this.objects;
  }

  /** Editor data for a material, e.g. { nodeGraph: { nodes: [...], links: [...] } }. */
  material(ref) {
    const i = this.materialIndex(ref);
    const record = (this.materials[i] ??= {});
    record.name = this.gltf.materials[i].name ?? null;
    record.nodeGraph ??= { nodes: [], links: [] };
    return record;
  }

  // ---- collections ----------------------------------------------------------

  /** Get or create a collection. `options` (parent, color, hideViewport, …) are merged in. */
  collection(name, options = {}) {
    let c = this.collections.find((x) => x.name === name);
    if (!c) {
      c = { name, parent: null, color: null, hideViewport: false, hideRender: false, hideSelect: false, objects: [] };
      this.collections.push(c);
    }
    Object.assign(c, options);
    if (c.parent !== null && !this.collections.some((x) => x.name === c.parent)) this.collection(c.parent);
    return c;
  }

  /** Link objects into a collection (an object may be in several, as in Blender). */
  link(collectionName, ...refs) {
    const c = this.collection(collectionName);
    for (const ref of refs.flat()) {
      const i = this.nodeIndex(ref);
      if (!c.objects.includes(i)) c.objects.push(i);
    }
    return c;
  }

  unlink(collectionName, ...refs) {
    const c = this.collections.find((x) => x.name === collectionName);
    if (!c) return;
    const drop = new Set(refs.flat().map((r) => this.nodeIndex(r)));
    c.objects = c.objects.filter((i) => !drop.has(i));
  }

  collectionsOf(ref) {
    const i = this.nodeIndex(ref);
    return this.collections.filter((c) => c.objects.includes(i)).map((c) => c.name);
  }

  // ---- editor state, timeline, history, texts --------------------------------

  /** Replace the selection. The active object defaults to the last selected. */
  select(refs, { active } = {}) {
    this.editor.selection = [...new Set(refs.map((r) => this.nodeIndex(r)))];
    this.editor.activeObject =
      active !== undefined ? this.nodeIndex(active) : (this.editor.selection.at(-1) ?? null);
  }

  /** Add a saved viewport ({ projection, position, target, up, fov, shading, ... }). */
  addViewport(viewport) {
    const v = { name: `View ${this.editor.viewports.length + 1}`, projection: 'perspective', shading: 'solid', ...viewport };
    this.editor.viewports.push(v);
    return v;
  }

  addMarker(name, frame, extra = {}) {
    const m = { name, frame, ...extra };
    this.animation.markers.push(m);
    this.animation.markers.sort((a, b) => a.frame - b.frame);
    return m;
  }

  /** Per-animation editor data (frame range, loop, …) for a glTF animation by index or name. */
  action(ref) {
    const anims = this.gltf.animations ?? [];
    const i = typeof ref === 'number' ? ref : anims.findIndex((a) => a.name === ref);
    if (!Number.isInteger(i) || i < 0 || i >= anims.length) throw new Error(`No glTF animation ${JSON.stringify(ref)}`);
    const record = (this.animation.actions[i] ??= {});
    record.name = anims[i].name ?? null;
    return record;
  }

  /** Record an undo step. Oldest entries are dropped beyond history.limit. */
  pushHistory(label, data = null) {
    this.history.entries.push({ label, time: new Date().toISOString(), data });
    const over = this.history.entries.length - this.history.limit;
    if (over > 0) this.history.entries.splice(0, over);
  }

  // ---- binary & custom blocks -----------------------------------------------

  /** PNG preview image (like a .blend thumbnail), or null. */
  get thumbnail() {
    return this.#extra.get('thumbnail')?.bytes ?? null;
  }

  set thumbnail(png) {
    if (png === null) return void this.#extra.delete('thumbnail');
    png = toBytes(png);
    if (!isPng(png)) throw new Error('Thumbnail must be a PNG');
    this.#extra.set('thumbnail', { type: 'binary', bytes: png, mime: 'image/png' });
  }

  /** Free-form data written by embed()/extract(). */
  get data() {
    return this.#extra.get('data')?.value ?? null;
  }

  set data(value) {
    if (value === null) this.#extra.delete('data');
    else this.#extra.set('data', { type: 'json', value });
  }

  /** Custom block: JSON-able value, or Uint8Array for binary. Returns undefined if absent. */
  getBlock(name) {
    if (SECTIONS.includes(name)) return this[name];
    const b = this.#extra.get(name);
    return b && (b.type === 'json' ? b.value : b.bytes);
  }

  /** Store a custom block, e.g. setBlock('myplugin', {...}) or setBlock('bake', bytes, { mime }). */
  setBlock(name, value, { mime } = {}) {
    if (RESERVED.has(name)) throw new Error(`"${name}" is a built-in block; use the matching property instead`);
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      this.#extra.set(name, { type: 'binary', bytes: toBytes(value), ...(mime && { mime }) });
    } else {
      this.#extra.set(name, { type: 'json', value });
    }
  }

  deleteBlock(name) {
    if (RESERVED.has(name) && name !== 'thumbnail' && name !== 'data') throw new Error(`Cannot delete built-in block "${name}"`);
    return this.#extra.delete(name);
  }

  blockNames() {
    return [...SECTIONS, ...this.#extra.keys()];
  }

  // ---- import / export ------------------------------------------------------

  /** All JSON sections plus JSON custom blocks, e.g. for editing as a .json file. */
  toJSON() {
    const out = {};
    for (const name of SECTIONS) out[name] = this[name];
    if (this.data !== null) out.data = this.data;
    const custom = {};
    for (const [name, b] of this.#extra) if (b.type === 'json' && name !== 'data') custom[name] = b.value;
    if (Object.keys(custom).length) out.blocks = custom;
    return clone(out);
  }

  /** Apply sections from toJSON() output. Sections not present are left alone. */
  applyJSON(doc) {
    const defaults = sectionDefaults(this.gltf);
    for (const name of SECTIONS) if (name in doc) this[name] = withDefaults(defaults[name], clone(doc[name]));
    if ('data' in doc) this.data = clone(doc.data);
    for (const [name, value] of Object.entries(doc.blocks ?? {})) this.setBlock(name, clone(value));
    this.#reconcile();
  }

  /** Serialize to .scene.glb bytes. */
  async save({ generator = 'scenefile' } = {}) {
    const blocks = new Map();
    for (const name of SECTIONS) blocks.set(name, { type: 'json', value: this[name] });
    for (const [name, block] of this.#extra) blocks.set(name, block);
    return writeGlb(await setSceneChunk(this.#glb, blocks, { generator }));
  }

  // ---- inspection -----------------------------------------------------------

  /** Counts and stats about the file, similar to Blender's scene statistics. */
  summary() {
    const g = this.gltf;
    const accessors = g.accessors ?? [];
    let triangles = 0;
    let vertices = 0;
    let primitives = 0;
    for (const mesh of g.meshes ?? []) {
      for (const p of mesh.primitives ?? []) {
        primitives++;
        const positions = accessors[p.attributes?.POSITION]?.count ?? 0;
        vertices += positions;
        if ((p.mode ?? 4) === 4) triangles += Math.floor((p.indices !== undefined ? accessors[p.indices]?.count ?? 0 : positions) / 3);
      }
    }
    return {
      gltfGenerator: g.asset?.generator ?? null,
      scene: this.scene.name,
      frames: [this.scene.frameStart, this.scene.frameEnd],
      fps: this.scene.fps,
      counts: {
        nodes: g.nodes?.length ?? 0,
        meshes: g.meshes?.length ?? 0,
        primitives,
        vertices,
        triangles,
        materials: g.materials?.length ?? 0,
        textures: g.textures?.length ?? 0,
        images: g.images?.length ?? 0,
        animations: g.animations?.length ?? 0,
        cameras: g.cameras?.length ?? 0,
        lights: g.extensions?.KHR_lights_punctual?.lights?.length ?? 0,
        skins: g.skins?.length ?? 0,
        collections: this.collections.length,
        objectsWithEditorData: Object.keys(this.objects).length,
        markers: this.animation.markers.length,
        viewports: this.editor.viewports.length,
        historyEntries: this.history.entries.length,
        texts: Object.keys(this.texts).length,
      },
      hasThumbnail: this.thumbnail !== null,
      customBlocks: [...this.#extra.keys()].filter((n) => !RESERVED.has(n)),
    };
  }

  /** A text tree of the scene, like Blender's outliner. */
  outline() {
    const g = this.gltf;
    const nodes = g.nodes ?? [];
    const cam = this.scene.activeCamera;
    const lines = [
      `Scene "${this.scene.name}" · frames ${this.scene.frameStart}–${this.scene.frameEnd} @ ${this.scene.fps} fps` +
        (cam !== null && nodes[cam] ? ` · camera: ${nodes[cam].name ?? `#${cam}`}` : ''),
    ];
    const selected = new Set(this.editor.selection);
    const label = (i) => {
      const o = this.objects[i] ?? {};
      const tags = [
        i === this.editor.activeObject && 'active',
        selected.has(i) && i !== this.editor.activeObject && 'selected',
        o.hideViewport && 'hidden',
        o.hideRender && 'no-render',
        o.hideSelect && 'unselectable',
        o.locked && 'locked',
        o.modifiers?.length && `${o.modifiers.length} modifier${o.modifiers.length > 1 ? 's' : ''}`,
        o.constraints?.length && `${o.constraints.length} constraint${o.constraints.length > 1 ? 's' : ''}`,
      ].filter(Boolean);
      const cols = this.collections.filter((c) => c.objects.includes(i)).map((c) => c.name);
      return `${nodes[i].name ?? `#${i}`} (${this.nodeKind(i)})` +
        (cols.length ? ` [${cols.join(', ')}]` : '') +
        (tags.length ? ` {${tags.join(', ')}}` : '');
    };
    const seen = new Set();
    const walk = (i, prefix, last) => {
      if (seen.has(i) || !nodes[i]) return;
      seen.add(i);
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${label(i)}`);
      const kids = nodes[i].children ?? [];
      kids.forEach((k, j) => walk(k, prefix + (last ? '   ' : '│  '), j === kids.length - 1));
    };
    const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? [];
    roots.forEach((r, j) => walk(r, '', j === roots.length - 1));

    const orphans = nodes.map((_, i) => i).filter((i) => !seen.has(i));
    if (orphans.length) {
      lines.push('Not in scene:');
      orphans.forEach((i, j) => walk(i, '', j === orphans.length - 1));
    }
    if (this.collections.length) {
      lines.push('Collections:');
      const byParent = (p) => this.collections.filter((c) => c.parent === p);
      const walkCol = (c, depth) => {
        const flags = [c.hideViewport && 'hidden', c.hideRender && 'no-render'].filter(Boolean);
        lines.push(`${'  '.repeat(depth + 1)}${c.name} (${c.objects.length} object${c.objects.length === 1 ? '' : 's'})` +
          (flags.length ? ` {${flags.join(', ')}}` : ''));
        byParent(c.name).forEach((child) => walkCol(child, depth + 1));
      };
      byParent(null).forEach((c) => walkCol(c, 0));
    }
    return lines.join('\n');
  }

  /** Check references and settings. Returns [{ level: 'error' | 'warning', message }]. */
  validate() {
    const issues = [];
    const err = (message) => issues.push({ level: 'error', message });
    const warn = (message) => issues.push({ level: 'warning', message });
    const nodes = this.gltf.nodes ?? [];
    const validNode = (i) => Number.isInteger(i) && i >= 0 && i < nodes.length;

    const s = this.scene;
    if (!(s.fps > 0)) err(`scene.fps must be positive (got ${s.fps})`);
    if (s.frameEnd < s.frameStart) err(`scene.frameEnd (${s.frameEnd}) is before frameStart (${s.frameStart})`);
    if (s.frameCurrent < s.frameStart || s.frameCurrent > s.frameEnd) warn(`scene.frameCurrent ${s.frameCurrent} is outside the frame range`);
    if (s.activeCamera !== null) {
      if (!validNode(s.activeCamera)) err(`scene.activeCamera points to missing node ${s.activeCamera}`);
      else if (nodes[s.activeCamera].camera === undefined) warn(`scene.activeCamera node "${nodes[s.activeCamera].name}" has no camera`);
    }

    for (const [key, o] of Object.entries(this.objects)) {
      const i = Number(key);
      if (!validNode(i)) err(`objects[${key}] points to a missing node`);
      else if (o.name != null && nodes[i].name !== o.name) warn(`objects[${key}] is named "${o.name}" but the node is "${nodes[i].name}"`);
      if (o.modifiers && !Array.isArray(o.modifiers)) err(`objects[${key}].modifiers must be an array`);
      for (const [j, m] of (Array.isArray(o.modifiers) ? o.modifiers : []).entries()) {
        if (!m?.type) err(`objects[${key}].modifiers[${j}] has no type`);
      }
    }

    const names = new Set();
    for (const c of this.collections) {
      if (names.has(c.name)) err(`Duplicate collection name "${c.name}"`);
      names.add(c.name);
      for (const i of c.objects ?? []) if (!validNode(i)) err(`Collection "${c.name}" links missing node ${i}`);
    }
    for (const c of this.collections) {
      if (c.parent !== null && !names.has(c.parent)) err(`Collection "${c.name}" has missing parent "${c.parent}"`);
      const visited = new Set([c.name]);
      for (let p = c.parent; p !== null; p = this.collections.find((x) => x.name === p)?.parent ?? null) {
        if (visited.has(p)) {
          err(`Collection "${c.name}" is part of a parent cycle`);
          break;
        }
        visited.add(p);
      }
    }

    for (const i of this.editor.selection) if (!validNode(i)) err(`editor.selection contains missing node ${i}`);
    const active = this.editor.activeObject;
    if (active !== null && !validNode(active)) err(`editor.activeObject points to missing node ${active}`);

    const materials = this.gltf.materials ?? [];
    for (const key of Object.keys(this.materials)) if (!materials[Number(key)]) err(`materials[${key}] points to a missing material`);
    const animations = this.gltf.animations ?? [];
    for (const key of Object.keys(this.animation.actions)) if (!animations[Number(key)]) err(`animation.actions[${key}] points to a missing animation`);
    return issues;
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Stored records reference nodes/materials by index and remember their names.
   * If the glTF JSON was edited so indices moved, re-find them by name and
   * update every reference; drop the ones that no longer exist.
   */
  #reconcile() {
    const nodes = this.gltf.nodes ?? [];
    const remap = new Map();
    const next = {};
    for (const [key, record] of Object.entries(this.objects)) {
      const i = Number(key);
      let target = i;
      if (record?.name != null && nodes[i]?.name !== record.name) {
        target = nodes.findIndex((n) => n.name === record.name);
        if (target === -1) {
          this.loadWarnings.push(`Dropped editor data for missing node "${record.name}"`);
          remap.set(i, null);
          continue;
        }
        this.loadWarnings.push(`Node "${record.name}" moved from index ${i} to ${target}`);
      }
      remap.set(i, target);
      next[target] = record;
    }
    this.objects = next;

    const moved = [...remap].some(([from, to]) => from !== to);
    if (moved) {
      const map = (i) => (remap.has(i) ? remap.get(i) : i);
      for (const c of this.collections) c.objects = c.objects.map(map).filter((i) => i !== null);
      this.editor.selection = this.editor.selection.map(map).filter((i) => i !== null);
      if (this.editor.activeObject !== null) this.editor.activeObject = map(this.editor.activeObject);
      if (this.scene.activeCamera !== null) this.scene.activeCamera = map(this.scene.activeCamera);
    }

    const materials = this.gltf.materials ?? [];
    const nextMaterials = {};
    for (const [key, record] of Object.entries(this.materials)) {
      const i = Number(key);
      if (record?.name == null || materials[i]?.name === record.name) {
        nextMaterials[i] = record;
        continue;
      }
      const target = materials.findIndex((m) => m.name === record.name);
      if (target === -1) this.loadWarnings.push(`Dropped editor data for missing material "${record.name}"`);
      else nextMaterials[target] = record;
    }
    this.materials = nextMaterials;
  }
}
