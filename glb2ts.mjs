#!/usr/bin/env node
/**
 * glb2ts — convert a 3D model file into a self-contained TypeScript module
 * that rebuilds the model with Three.js at runtime. No AI, no approximation:
 * the model's own numbers (geometry, materials, textures, node tree) are
 * carried into code verbatim.
 *
 *   node glb2ts.mjs <model.glb|model.gltf|model.obj|model.stl|model.ply> [options]
 *
 * Options:
 *   -o, --out <file>   output file (default: <model-name>.ts next to the input)
 *   --js               emit plain JavaScript (.mjs-style body) instead of TypeScript
 *   --name <Name>      exported builder name suffix (default: from the file name)
 *
 * Supported: static models. GLB/GLTF with embedded or sibling resources,
 * PBR materials and textures; OBJ (+ .mtl colors/textures), STL, PLY.
 * Not supported: skinning, morph targets, animation (warned + skipped),
 * Draco / meshopt compression, KTX2 textures (hard error — re-export first).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// ---------------------------------------------------------------------------
// Intermediate representation
//   model = { name, roots: [node], geometries: [], materials: [], textures: [], warnings: [] }
//   node  = { name, position:[3], quaternion:[4], scale:[3], mesh: {geometry, material} | null,
//             extraMeshes: [{geometry, material}], children: [node] }
//   geometry = { attributes: [{name, array, itemSize}], index: TypedArray | null }
//   material = { kind: 'standard'|'basic', color:[r,g,b], opacity, metalness, roughness,
//                emissive:[r,g,b], emissiveIntensity, alphaTest, transparent, doubleSided,
//                vertexColors, flatShading, maps: { slot: {tex, channel, scale?} } }
//   texture  = { bytes: Buffer, mime, wrapS, wrapT, magFilter, minFilter }
// ---------------------------------------------------------------------------

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.error('warning:', msg); };

function sanitizeIdent(name, fallback) {
  let s = String(name || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = fallback;
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}
function pascal(name) {
  const s = sanitizeIdent(name, 'Model').split('_').filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return s || 'Model';
}

// ===========================================================================
// GLB / GLTF
// ===========================================================================

const COMPONENT_TYPES = {
  5120: { Ctor: Int8Array, size: 1, read: 'getInt8' },
  5121: { Ctor: Uint8Array, size: 1, read: 'getUint8' },
  5122: { Ctor: Int16Array, size: 2, read: 'getInt16' },
  5123: { Ctor: Uint16Array, size: 2, read: 'getUint16' },
  5125: { Ctor: Uint32Array, size: 4, read: 'getUint32' },
  5126: { Ctor: Float32Array, size: 4, read: 'getFloat32' },
};
const TYPE_SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function loadGltf(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const dir = path.dirname(inputPath);
  let gltf, binChunks = [];
  if (ext === '.glb') {
    const buf = fs.readFileSync(inputPath);
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file (bad magic)');
    let off = 12;
    while (off < buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      const chunk = buf.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) gltf = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) binChunks.push(Buffer.from(chunk));
      off += 8 + len;
    }
    if (!gltf) throw new Error('GLB has no JSON chunk');
  } else {
    gltf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  }

  const used = gltf.extensionsUsed || [];
  for (const bad of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression']) {
    if (used.includes(bad)) {
      throw new Error(`this model uses ${bad}; glb2ts cannot decode compressed geometry — re-export it uncompressed first`);
    }
  }
  if (gltf.animations?.length) warn(`${gltf.animations.length} animation(s) skipped — static models only`);
  if (gltf.skins?.length) warn('skinning present — skinning is skipped, the model converts in its bind pose');

  const buffers = (gltf.buffers || []).map((b, i) => {
    if (i === 0 && binChunks.length) return binChunks[0];
    if (b.uri && b.uri.startsWith('data:')) return Buffer.from(b.uri.split(',')[1], 'base64');
    if (b.uri) return fs.readFileSync(path.join(dir, decodeURIComponent(b.uri)));
    return Buffer.alloc(0);
  });

  function readAccessor(idx) {
    const acc = gltf.accessors[idx];
    const comp = COMPONENT_TYPES[acc.componentType];
    const nComp = TYPE_SIZES[acc.type];
    const count = acc.count;
    let out;
    if (acc.bufferView !== undefined) {
      const bv = gltf.bufferViews[acc.bufferView];
      const buf = buffers[bv.buffer || 0];
      const elemBytes = comp.size * nComp;
      const stride = bv.byteStride || elemBytes;
      const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      if (stride === elemBytes && !acc.normalized) {
        const bytes = Uint8Array.from(buf.subarray(start, start + elemBytes * count));
        out = new comp.Ctor(bytes.buffer);
      } else {
        out = new comp.Ctor(count * nComp);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let i = 0; i < count; i++) {
          for (let c = 0; c < nComp; c++) {
            out[i * nComp + c] = dv[comp.read](start + i * stride + c * comp.size, true);
          }
        }
      }
    } else {
      out = new comp.Ctor(count * nComp);
    }
    if (acc.normalized) {
      const f = new Float32Array(out.length);
      const max = acc.componentType === 5121 ? 255 : acc.componentType === 5123 ? 65535 : 1;
      const min = acc.componentType === 5120 ? -128 : acc.componentType === 5122 ? -32768 : 0;
      for (let i = 0; i < out.length; i++) {
        f[i] = min < 0 ? Math.max(out[i] / -min, -1) : out[i] / max;
      }
      out = f;
    }
    if (acc.sparse) {
      const idxAcc = readAccessorRaw(gltf.accessors[acc.sparse.indices], buffers);
      const valAcc = readAccessorRaw(gltf.accessors[acc.sparse.values], buffers);
      for (let i = 0; i < acc.sparse.count; i++) {
        for (let c = 0; c < nComp; c++) out[idxAcc[i] * nComp + c] = valAcc[i * nComp + c];
      }
    }
    return out;
  }
  // Minimal accessor read used for sparse index/value lists (no nesting).
  function readAccessorRaw(acc, bufs) {
    const comp = COMPONENT_TYPES[acc.componentType];
    const nComp = TYPE_SIZES[acc.type];
    const bv = gltf.bufferViews[acc.bufferView];
    const buf = bufs[bv.buffer || 0];
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const bytes = Uint8Array.from(buf.subarray(start, start + comp.size * nComp * acc.count));
    return new comp.Ctor(bytes.buffer);
  }

  // --- textures ------------------------------------------------------------
  const textures = [];
  function loadTexture(texIdx) {
    const tex = gltf.textures[texIdx];
    if (tex?.extensions?.KHR_texture_basisu) {
      warn(`texture ${texIdx} is KTX2/basisu — skipped (re-export as PNG/JPEG to keep it)`);
      return -1;
    }
    const img = gltf.images[tex.source];
    let bytes, mime = img.mimeType;
    if (img.bufferView !== undefined) {
      const bv = gltf.bufferViews[img.bufferView];
      const buf = buffers[bv.buffer || 0];
      bytes = Buffer.from(buf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    } else if (img.uri?.startsWith('data:')) {
      mime = mime || img.uri.slice(5, img.uri.indexOf(';'));
      bytes = Buffer.from(img.uri.split(',')[1], 'base64');
    } else if (img.uri) {
      bytes = fs.readFileSync(path.join(dir, decodeURIComponent(img.uri)));
      mime = mime || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(img.uri).toLowerCase()]);
    }
    if (!bytes) { warn(`texture ${texIdx}: could not read its image — skipped`); return -1; }
    const sampler = gltf.samplers?.[tex.sampler || 0] || {};
    textures.push({
      bytes, mime: mime || 'image/png',
      wrapS: sampler.wrapS ?? 10497, wrapT: sampler.wrapT ?? 10497,
      magFilter: sampler.magFilter ?? 9729, minFilter: sampler.minFilter ?? 9987,
    });
    return textures.length - 1;
  }
  const texCache = new Map(); // gltf texture index -> IR texture index
  const getTex = (i) => {
    if (!texCache.has(i)) texCache.set(i, loadTexture(i));
    return texCache.get(i);
  };

  // --- materials -----------------------------------------------------------
  function convertMaterial(m) {
    if (!m) {
      return { kind: 'standard', color: [1, 1, 1], opacity: 1, metalness: 0, roughness: 1, emissive: [0, 0, 0], emissiveIntensity: 1, alphaTest: 0, transparent: false, doubleSided: false, vertexColors: false, maps: {} };
    }
    const pbr = m.pbrMetallicRoughness || {};
    const out = {
      kind: m.extensions?.KHR_materials_unlit ? 'basic' : 'standard',
      color: (pbr.baseColorFactor || [1, 1, 1, 1]).slice(0, 3),
      opacity: (pbr.baseColorFactor || [1, 1, 1, 1])[3] ?? 1,
      metalness: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: m.emissiveFactor || [0, 0, 0],
      emissiveIntensity: m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      alphaTest: m.alphaMode === 'MASK' ? (m.alphaCutoff ?? 0.5) : 0,
      transparent: m.alphaMode === 'BLEND',
      doubleSided: Boolean(m.doubleSided),
      vertexColors: false,
      maps: {},
    };
    const slot = (info, key, extra) => {
      if (!info) return;
      const t = getTex(info.index);
      if (t < 0) return;
      out.maps[key] = { tex: t, channel: info.texCoord || 0, ...extra };
    };
    slot(pbr.baseColorTexture, 'map');
    slot(pbr.metallicRoughnessTexture, 'metalnessMap');
    if (pbr.metallicRoughnessTexture) slot(pbr.metallicRoughnessTexture, 'roughnessMap');
    slot(m.normalTexture, 'normalMap', { scale: m.normalTexture?.scale ?? 1 });
    slot(m.occlusionTexture, 'aoMap');
    slot(m.emissiveTexture, 'emissiveMap');
    const spec = m.extensions?.KHR_materials_specular;
    if (spec) {
      out.specularIntensity = spec.specularFactor ?? 1;
      if (spec.specularColorFactor) out.specularColor = spec.specularColorFactor.slice(0, 3);
      slot(spec.specularTexture, 'specularIntensityMap');
      slot(spec.specularColorTexture, 'specularColorMap');
    }
    for (const ext of Object.keys(m.extensions || {})) {
      if (!['KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_materials_specular'].includes(ext)) {
        warn(`material "${m.name || ''}": extension ${ext} not carried over`);
      }
    }
    return out;
  }
  const materials = (gltf.materials || []).map(convertMaterial);

  // --- geometries ------------------------------------------------------------
  const geometries = [];
  function convertPrimitive(prim) {
    if ((prim.mode ?? 4) !== 4) { warn('a non-triangle primitive was skipped'); return -1; }
    if (prim.attributes.JOINTS_0 || prim.attributes.WEIGHTS_0) warn('a skinned primitive converts without skinning');
    const attrs = [];
    const nameMap = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', COLOR_0: 'color' };
    for (const [gltfName, attrName] of Object.entries(nameMap)) {
      if (prim.attributes[gltfName] !== undefined) {
        const arr = readAccessor(prim.attributes[gltfName]);
        attrs.push({ name: attrName, array: arr, itemSize: arr.length / gltf.accessors[prim.attributes[gltfName]].count });
      }
    }
    for (let i = 0; i < 4; i++) {
      const key = `TEXCOORD_${i}`;
      if (prim.attributes[key] !== undefined) {
        const arr = readAccessor(prim.attributes[key]);
        attrs.push({ name: i === 0 ? 'uv' : `uv${i}`, array: arr, itemSize: 2 });
      }
    }
    const index = prim.indices !== undefined ? readAccessor(prim.indices) : null;
    geometries.push({ attributes: attrs, index });
    return geometries.length - 1;
  }

  // --- nodes -----------------------------------------------------------------
  function convertNode(ni) {
    const n = gltf.nodes[ni];
    const node = { name: n.name || `node_${ni}`, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mesh: null, extraMeshes: [], children: [] };
    if (n.matrix) {
      const m = new THREE.Matrix4().fromArray(n.matrix);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      node.position = p.toArray(); node.quaternion = q.toArray(); node.scale = s.toArray();
    } else {
      if (n.translation) node.position = n.translation;
      if (n.rotation) node.quaternion = n.rotation;
      if (n.scale) node.scale = n.scale;
    }
    if (n.mesh !== undefined) {
      const prims = gltf.meshes[n.mesh].primitives
        .map((p) => ({ geometry: convertPrimitive(p), material: p.material ?? -1 }))
        .filter((p) => p.geometry >= 0);
      if (prims.length) {
        node.mesh = prims[0];
        node.extraMeshes = prims.slice(1);
      }
    }
    node.children = (n.children || []).map(convertNode);
    return node;
  }
  const scene = gltf.scenes[gltf.scene || 0];
  const roots = (scene?.nodes || []).map(convertNode);
  return { geometries, materials, textures, roots };
}

// Post-pass for the GLB path: a material used by a primitive that carries
// COLOR_0 must render with vertexColors on (glTF multiplies base color by
// the vertex color).
function applyVertexColorFlags(model) {
  const mark = (meshRef) => {
    if (!meshRef || meshRef.material < 0) return;
    const geo = model.geometries[meshRef.geometry];
    if (geo?.attributes.some((a) => a.name === 'color')) {
      model.materials[meshRef.material].vertexColors = true;
    }
  };
  const walk = (n) => { mark(n.mesh); n.extraMeshes.forEach(mark); n.children.forEach(walk); };
  model.roots.forEach(walk);
}

// ===========================================================================
// OBJ / STL / PLY (parsed with three's own loaders, then read back into IR)
// ===========================================================================

function geometryToIR(geo) {
  const attrs = [];
  const nameMap = { position: 'position', normal: 'normal', uv: 'uv', uv1: 'uv1', color: 'color', tangent: 'tangent' };
  for (const [src, dst] of Object.entries(nameMap)) {
    const attr = geo.getAttribute(src);
    if (attr) attrs.push({ name: dst, array: attr.array, itemSize: attr.itemSize });
  }
  return { attributes: attrs, index: geo.index ? geo.index.array : null };
}

function defaultMaterial(overrides = {}) {
  return {
    kind: 'standard', color: [1, 1, 1], opacity: 1, metalness: 0, roughness: 1,
    emissive: [0, 0, 0], emissiveIntensity: 1, alphaTest: 0, transparent: false,
    doubleSided: false, vertexColors: false, maps: {}, ...overrides,
  };
}

function objectTreeToIR(rootObj, materials, geometries, materialForMesh) {
  const convert = (obj) => {
    const node = {
      name: obj.name || 'node',
      position: obj.position.toArray(), quaternion: obj.quaternion.toArray(), scale: obj.scale.toArray(),
      mesh: null, extraMeshes: [], children: [],
    };
    if (obj.isMesh) {
      geometries.push(geometryToIR(obj.geometry));
      const gi = geometries.length - 1;
      node.mesh = materialForMesh(obj, gi);
    }
    node.children = (obj.children || []).map(convert).filter(Boolean);
    return node;
  };
  return convert(rootObj);
}

function loadObj(inputPath) {
  const text = fs.readFileSync(inputPath, 'utf8');
  const dir = path.dirname(inputPath);
  const textures = [];
  const materials = [];
  const matByName = new Map();

  // Parse a sibling .mtl (if the OBJ names one) for colors + diffuse maps.
  const mtlMatch = text.match(/^mtllib\s+(.+)$/m);
  const mtlDefs = new Map();
  if (mtlMatch) {
    const mtlPath = path.join(dir, mtlMatch[1].trim());
    if (fs.existsSync(mtlPath)) {
      let cur = null;
      for (const line of fs.readFileSync(mtlPath, 'utf8').split(/\r?\n/)) {
        const [key, ...rest] = line.trim().split(/\s+/);
        const val = rest.join(' ');
        if (key === 'newmtl') { cur = { name: val, color: [1, 1, 1], opacity: 1, emissive: [0, 0, 0], map: null }; mtlDefs.set(val, cur); }
        else if (!cur) continue;
        else if (key === 'Kd') cur.color = rest.map(Number);
        else if (key === 'Ke') cur.emissive = rest.map(Number);
        else if (key === 'd') cur.opacity = Number(val);
        else if (key === 'Tr') cur.opacity = 1 - Number(val);
        else if (key === 'map_Kd') cur.map = val.split(/\s+/).pop();
      }
    } else {
      warn(`mtllib "${mtlMatch[1].trim()}" not found next to the OBJ — materials convert as plain colors`);
    }
  }
  const materialIndexFor = (name) => {
    if (matByName.has(name)) return matByName.get(name);
    const def = mtlDefs.get(name);
    const mat = defaultMaterial();
    if (def) {
      mat.color = def.color; mat.emissive = def.emissive;
      mat.opacity = def.opacity; mat.transparent = def.opacity < 1;
      if (def.map) {
        const imgPath = path.join(dir, def.map);
        if (fs.existsSync(imgPath)) {
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(imgPath).toLowerCase()];
          if (mime) {
            textures.push({ bytes: fs.readFileSync(imgPath), mime, wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 });
            mat.maps.map = { tex: textures.length - 1, channel: 0 };
          }
        } else warn(`MTL texture "${def.map}" not found — that material converts without its texture`);
      }
    }
    materials.push(mat);
    matByName.set(name, materials.length - 1);
    return materials.length - 1;
  };

  const rootObj = new OBJLoader().parse(text);
  const geometries = [];
  const roots = [objectTreeToIR(rootObj, materials, geometries, (mesh) => {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = mesh.geometry.groups || [];
    if (groups.length > 1 || (groups.length === 1 && groups[0].materialIndex !== 0)) {
      return {
        geometry: geometries.length - 1,
        groupMaterials: groups.map((g) => ({
          start: g.start, count: g.count,
          material: materialIndexFor(mats[g.materialIndex]?.name || ''),
        })),
      };
    }
    return { geometry: geometries.length - 1, material: materialIndexFor(mats[0]?.name || '') };
  })];
  return { geometries, materials, textures, roots };
}

function loadSimple(inputPath, kind) {
  const buf = fs.readFileSync(inputPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const geo = kind === 'stl' ? new STLLoader().parse(ab) : new PLYLoader().parse(ab);
  const geometries = [geometryToIR(geo)];
  const hasColor = geometries[0].attributes.some((a) => a.name === 'color');
  const materials = [defaultMaterial({ color: [0.85, 0.88, 0.95], vertexColors: hasColor })];
  const node = {
    name: path.basename(inputPath, path.extname(inputPath)),
    position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    mesh: { geometry: 0, material: 0 }, extraMeshes: [], children: [],
  };
  return { geometries, materials, textures: [], roots: [node] };
}

// ===========================================================================
// Emitter — IR -> TypeScript (or plain JS with --js)
// ===========================================================================

function emit(model, { ts, createName, sourceName }) {
  const usedReaders = new Set();
  const readerFor = (arr) => {
    if (arr instanceof Float32Array) { usedReaders.add('_f32'); return '_f32'; }
    if (arr instanceof Uint32Array) { usedReaders.add('_u32'); return '_u32'; }
    if (arr instanceof Uint16Array) { usedReaders.add('_u16'); return '_u16'; }
    if (arr instanceof Uint8Array) { usedReaders.add('_u8'); return '_u8'; }
    if (arr instanceof Int32Array) { usedReaders.add('_i32'); return '_i32'; }
    if (arr instanceof Int16Array) { usedReaders.add('_i16'); return '_i16'; }
    if (arr instanceof Int8Array) { usedReaders.add('_i8'); return '_i8'; }
    throw new Error('unsupported array type: ' + arr.constructor.name);
  };
  const b64Of = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
  const b64Lit = (arr) => {
    const s = b64Of(arr);
    if (s.length <= 116) return `"${s}"`;
    const chunks = [];
    for (let i = 0; i < s.length; i += 116) chunks.push(`"${s.slice(i, i + 116)}"`);
    return chunks.join(' +\n    ');
  };
  // Exact shortest round-trip formatting — a generated file must carry the
  // model's numbers bit-for-bit, never rounded.
  const fmt = (x) => (Object.is(Number(x), -0) ? '0' : JSON.stringify(Number(x)));
  // glTF color factors are linear-space components (GLTFLoader copies them
  // verbatim via setRGB(..., LinearSRGBColorSpace)). Emitting a hex literal
  // would quantize to 8 bits AND get sRGB->linear converted a second time,
  // so colors are emitted as raw Color components instead.
  const colorLit = (c) => `new THREE.Color(${c.map(fmt).join(', ')})`;

  // Resolve texture consts: one THREE.Texture per (source texture, colorspace),
  // because three keeps colorSpace per texture and glTF shares one image
  // between color (sRGB) and data (linear) slots.
  const texConst = new Map();
  const texNameFor = (texIdx, srgb) => {
    const key = `${texIdx}:${srgb ? 's' : 'l'}`;
    if (!texConst.has(key)) texConst.set(key, `TEX_${texConst.size}`);
    return texConst.get(key);
  };
  const SRGB_SLOTS = new Set(['map', 'emissiveMap', 'specularColorMap']);
  for (const m of model.materials) {
    for (const [slot, info] of Object.entries(m.maps)) info.constName = texNameFor(info.tex, SRGB_SLOTS.has(slot));
  }

  const body = [];

  // --- textures ---
  const WRAP = { 10497: 'RepeatWrapping', 33071: 'ClampToEdgeWrapping', 33648: 'MirroredRepeatWrapping' };
  const MAG = { 9728: 'NearestFilter', 9729: 'LinearFilter' };
  const MIN = { 9728: 'NearestFilter', 9729: 'LinearFilter', 9984: 'NearestMipmapNearestFilter', 9985: 'LinearMipmapNearestFilter', 9986: 'NearestMipmapLinearFilter', 9987: 'LinearMipmapLinearFilter' };
  for (const [key, constName] of texConst) {
    const [texIdx, kind] = key.split(':');
    const t = model.textures[Number(texIdx)];
    body.push(`const ${constName} = (() => {`);
    body.push(`  const tex = new THREE.TextureLoader().load("data:${t.mime};base64,${t.bytes.toString('base64')}");`);
    body.push('  tex.flipY = false;');
    if (kind === 's') body.push('  tex.colorSpace = THREE.SRGBColorSpace;');
    if (WRAP[t.wrapS]) body.push(`  tex.wrapS = THREE.${WRAP[t.wrapS]};`);
    if (WRAP[t.wrapT]) body.push(`  tex.wrapT = THREE.${WRAP[t.wrapT]};`);
    if (MAG[t.magFilter] && t.magFilter !== 9729) body.push(`  tex.magFilter = THREE.${MAG[t.magFilter]};`);
    if (MIN[t.minFilter] && t.minFilter !== 9987) body.push(`  tex.minFilter = THREE.${MIN[t.minFilter]};`);
    body.push('  return tex;');
    body.push('})();');
  }

  // --- geometries ---
  model.geometries.forEach((g, i) => {
    body.push(`const GEO_${i} = (() => {`);
    body.push('  const g = new THREE.BufferGeometry();');
    for (const a of g.attributes) {
      body.push(`  g.setAttribute('${a.name}', new THREE.BufferAttribute(${readerFor(a.array)}(${b64Lit(a.array)}), ${a.itemSize}));`);
    }
    if (g.index) body.push(`  g.setIndex(new THREE.BufferAttribute(${readerFor(g.index)}(${b64Lit(g.index)}), 1));`);
    body.push('  return g;');
    body.push('})();');
  });

  // --- materials ---
  const matConst = (m) => {
    const p = [];
    if (m.kind === 'basic') {
      p.push(`color: ${colorLit(m.color)}`);
    } else {
      p.push(`color: ${colorLit(m.color)}`, `metalness: ${fmt(m.metalness)}`, `roughness: ${fmt(m.roughness)}`);
    }
    for (const slot of ['map', 'metalnessMap', 'roughnessMap', 'normalMap', 'aoMap', 'emissiveMap', 'specularIntensityMap', 'specularColorMap']) {
      const info = m.maps[slot];
      if (!info) continue;
      p.push(`${slot}: ${info.constName}`);
      if (info.channel) p.push(`${slot}Channel: ${info.channel}`);
      if (slot === 'normalMap' && info.scale !== undefined && info.scale !== 1) {
        p.push(`normalScale: new THREE.Vector2(${fmt(info.scale)}, ${fmt(info.scale)})`);
      }
    }
    if (m.emissive.some((v) => v !== 0)) {
      p.push(`emissive: ${colorLit(m.emissive)}`);
      if (m.emissiveIntensity !== 1) p.push(`emissiveIntensity: ${fmt(m.emissiveIntensity)}`);
    }
    if (m.opacity !== 1) p.push(`opacity: ${fmt(m.opacity)}`);
    if (m.transparent) p.push('transparent: true');
    if (m.alphaTest) p.push(`alphaTest: ${fmt(m.alphaTest)}`);
    if (m.doubleSided) p.push('side: THREE.DoubleSide');
    if (m.vertexColors) p.push('vertexColors: true');
    // KHR_materials_specular lives on MeshPhysicalMaterial in three.
    const hasSpecular = m.specularIntensity !== undefined || m.specularColor !== undefined
      || Boolean(m.maps.specularIntensityMap) || Boolean(m.maps.specularColorMap);
    if (hasSpecular) {
      if (m.specularIntensity !== undefined && m.specularIntensity !== 1) p.push(`specularIntensity: ${fmt(m.specularIntensity)}`);
      if (m.specularColor) p.push(`specularColor: ${colorLit(m.specularColor)}`);
    }
    const ctor = m.kind === 'basic' ? 'THREE.MeshBasicMaterial'
      : hasSpecular ? 'THREE.MeshPhysicalMaterial' : 'THREE.MeshStandardMaterial';
    return `new ${ctor}({ ${p.join(', ')} })`;
  };
  model.materials.forEach((m, i) => body.push(`const MAT_${i} = ${matConst(m)};`));
  const needsDefault = [];
  const walkRefs = (n) => { if (n.mesh) needsDefault.push(n.mesh); n.extraMeshes.forEach((e) => needsDefault.push(e)); n.children.forEach(walkRefs); };
  model.roots.forEach(walkRefs);
  const defaultFor = (meshRef) => {
    const geo = model.geometries[meshRef.geometry];
    return geo?.attributes.some((a) => a.name === 'color') ? 'MAT_DEFAULT_VC' : 'MAT_DEFAULT';
  };
  if (needsDefault.some((r) => r.material === -1)) {
    body.push('const MAT_DEFAULT = new THREE.MeshStandardMaterial();');
    if (needsDefault.some((r) => r.material === -1 && defaultFor(r) === 'MAT_DEFAULT_VC')) {
      body.push('const MAT_DEFAULT_VC = new THREE.MeshStandardMaterial({ vertexColors: true });');
    }
  }

  // --- builder ---
  const partNames = [];
  const build = [];
  let counter = 0;
  const emitNode = (node, parentVar) => {
    const v = `n${counter++}`;
    const hasKids = node.children.length > 0;
    const prims = node.mesh ? [node.mesh, ...node.extraMeshes] : [];
    const applyTransform = (target) => {
      if (node.position.some((x) => x !== 0)) build.push(`  ${target}.position.set(${node.position.map(fmt).join(', ')});`);
      if (node.quaternion.some((x, i) => x !== [0, 0, 0, 1][i])) build.push(`  ${target}.quaternion.set(${node.quaternion.map(fmt).join(', ')});`);
      if (node.scale.some((x) => x !== 1)) build.push(`  ${target}.scale.set(${node.scale.map(fmt).join(', ')});`);
    };
    if (prims.length === 1 && !hasKids && !prims[0].groupMaterials) {
      const r = prims[0];
      const mat = r.material === -1 ? defaultFor(r) : `MAT_${r.material}`;
      build.push(`  const ${v} = new THREE.Mesh(GEO_${r.geometry}, ${mat});`);
      build.push(`  ${v}.name = ${JSON.stringify(node.name)};`);
      applyTransform(v);
      partNames.push(node.name);
    } else if (prims.length || hasKids) {
      build.push(`  const ${v} = new THREE.Group();`);
      build.push(`  ${v}.name = ${JSON.stringify(node.name)};`);
      applyTransform(v);
      prims.forEach((r, pi) => {
        const mv = `${v}m${pi}`;
        if (r.groupMaterials) {
          const mats = r.groupMaterials.map((g) => `MAT_${g.material}`).join(', ');
          build.push(`  const ${mv} = new THREE.Mesh(GEO_${r.geometry}.clone(), [${mats}]);`);
          r.groupMaterials.forEach((g, gi) => build.push(`  ${mv}.geometry.addGroup(${g.start}, ${g.count}, ${gi});`));
        } else {
          const mat = r.material === -1 ? defaultFor(r) : `MAT_${r.material}`;
          build.push(`  const ${mv} = new THREE.Mesh(GEO_${r.geometry}, ${mat});`);
        }
        const nm = pi === 0 ? node.name : `${node.name}_${pi}`;
        build.push(`  ${mv}.name = ${JSON.stringify(nm)};`);
        build.push(`  ${v}.add(${mv});`);
        partNames.push(nm);
      });
    } else {
      build.push(`  const ${v} = new THREE.Group();`);
      build.push(`  ${v}.name = ${JSON.stringify(node.name)};`);
      applyTransform(v);
    }
    build.push(`  ${parentVar}.add(${v});`);
    node.children.forEach((c) => emitNode(c, v));
  };
  model.roots.forEach((r) => emitNode(r, 'root'));

  const tris = model.geometries.reduce((acc, g) => {
    const posCount = g.attributes.find((a) => a.name === 'position');
    const n = g.index ? g.index.length : (posCount ? posCount.array.length / posCount.itemSize : 0);
    return acc + Math.floor(n / 3);
  }, 0);

  const out = [];
  out.push('/**');
  out.push(` * Generated by glb2ts from ${sourceName} — do not edit by hand; re-run the converter.`);
  out.push(` * ${partNames.length} part(s), ${model.geometries.length} geometry(ies), ${model.materials.length} material(s), ${model.textures.length} texture(s), ${tris} triangles.`);
  for (const w of warnings) out.push(` * warning: ${w}`);
  out.push(' */');
  out.push("import * as THREE from 'three';");
  out.push('');
  // decode helpers (only the ones used)
  out.push(ts ? 'function _b64(s: string): Uint8Array {' : 'function _b64(s) {');
  out.push('  const bin = atob(s);');
  out.push('  const out = new Uint8Array(bin.length);');
  out.push('  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);');
  out.push('  return out;');
  out.push('}');
  const READER_DEFS = {
    _f32: 'Float32Array', _u32: 'Uint32Array', _u16: 'Uint16Array', _u8: 'Uint8Array',
    _i32: 'Int32Array', _i16: 'Int16Array', _i8: 'Int8Array',
  };
  for (const r of usedReaders) {
    out.push(ts
      ? `function ${r}(s: string): ${READER_DEFS[r]} { return new ${READER_DEFS[r]}(_b64(s).buffer); }`
      : `function ${r}(s) { return new ${READER_DEFS[r]}(_b64(s).buffer); }`);
  }
  out.push('');
  out.push(...body);
  out.push('');
  out.push(`export function create${createName}()${ts ? ': THREE.Group' : ''} {`);
  out.push('  const root = new THREE.Group();');
  out.push(`  root.name = ${JSON.stringify(sourceName.replace(/\.[^.]+$/, ''))};`);
  out.push(...build);
  out.push('  return root;');
  out.push('}');
  out.push('');
  out.push(`export const PART_NAMES = ${JSON.stringify(partNames)}${ts ? ' as const' : ''};`);
  out.push('');
  return out.join('\n');
}

// ===========================================================================
// Library entry point (the Hunyuan3D app imports this) + CLI
// ===========================================================================

function countParts(n) {
  return (n.mesh ? 1 + n.extraMeshes.length : 0) + n.children.reduce((a, c) => a + countParts(c), 0);
}

function countTriangles(model) {
  return model.geometries.reduce((acc, g) => {
    const pos = g.attributes.find((a) => a.name === 'position');
    const n = g.index ? g.index.length : (pos ? pos.array.length / pos.itemSize : 0);
    return acc + Math.floor(n / 3);
  }, 0);
}

/**
 * Convert one model file to TypeScript (or JS) source.
 * Returns { code, createName, warnings, stats } — throws on unsupported
 * formats or undecodable compression, with a plain-language message.
 * Conversions are sequential: the module-level warnings list is reset
 * per call.
 */
export function convertToTs(inputPath, opts = {}) {
  warnings.length = 0;
  const ext = path.extname(inputPath).toLowerCase();
  let model;
  if (ext === '.glb' || ext === '.gltf') { model = loadGltf(inputPath); applyVertexColorFlags(model); }
  else if (ext === '.obj') model = loadObj(inputPath);
  else if (ext === '.stl') model = loadSimple(inputPath, 'stl');
  else if (ext === '.ply') model = loadSimple(inputPath, 'ply');
  else if (ext === '.fbx') {
    throw new Error('FBX is not supported directly — export it as GLB first (e.g. open it in Blender and export glTF binary), then convert that.');
  } else {
    throw new Error('unsupported format: ' + (ext || '(none)'));
  }
  const createName = opts.name || pascal(path.basename(inputPath, path.extname(inputPath)));
  const code = emit(model, { ts: !opts.js, createName, sourceName: path.basename(inputPath) });
  return {
    code,
    createName,
    warnings: [...warnings],
    stats: {
      parts: model.roots.reduce((acc, r) => acc + countParts(r), 0),
      geometries: model.geometries.length,
      materials: model.materials.length,
      textures: model.textures.length,
      triangles: countTriangles(model),
    },
  };
}

function main(argv) {
  const args = argv.slice(2);
  const opts = { js: false, out: null, name: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--js') opts.js = true;
    else if (a === '-o' || a === '--out') opts.out = args[++i];
    else if (a === '--name') opts.name = args[++i];
    else if (a === '-h' || a === '--help') { console.log('usage: glb2ts <model.glb|.gltf|.obj|.stl|.ply> [-o out.ts] [--js] [--name Name]'); return; }
    else positional.push(a);
  }
  const input = positional[0];
  if (!input) { console.error('usage: glb2ts <model file> [options]'); process.exit(2); }
  if (!fs.existsSync(input)) { console.error('no such file:', input); process.exit(2); }

  let result;
  try {
    result = convertToTs(input, opts);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(2);
  }
  const outPath = opts.out || path.join(path.dirname(input), path.basename(input, path.extname(input)) + (opts.js ? '.js' : '.ts'));
  fs.writeFileSync(outPath, result.code);
  const s = result.stats;
  console.log(`wrote ${outPath} (${(result.code.length / 1024).toFixed(1)} KB) — ${s.parts} part(s), ${s.geometries} geometries, ${s.materials} materials, ${s.textures} textures, ${result.warnings.length} warning(s)`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
