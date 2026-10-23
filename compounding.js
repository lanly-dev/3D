/**
 * Compounding engine (main process).
 *
 * Keeps a persistent catalogue of the *parts* the app has produced, so every
 * conversion adds to a library that later work can reuse:
 *
 *   mesh -> MeshCoder -> <name>.blender.py  --(parts harvested)-->  part library
 *   library + meshes + previous scripts      --(compound)-->        <name>.compound.py
 *
 * The compound script is a real Blender 4.x file: it imports the base meshes
 * and *re-executes* the earlier generated scripts to re-use their objects
 * instead of regenerating them. Work therefore accumulates instead of being
 * thrown away after each conversion.
 *
 * Storage: <userData>/compounding.json
 *   { version, parts: [{ name, source, count }], chains: [...] }
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const assets = require('./assets');
const workspaces = require('./workspaces');

/** Objects/keywords that are scene plumbing, not model parts. */
const IGNORED_NAMES = new Set([
  'cube', 'sphere', 'plane', 'cylinder', 'cone', 'torus', 'icosphere',
  'camera', 'light', 'sun', 'area', 'point', 'spot',
  'empty', 'collection', 'scene', 'world', 'material', 'mesh',
  'object', 'objects', 'bpy', 'math', 'mathutils',
]);

function storePath() {
  return path.join(app.getPath('userData'), 'compounding.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return {
      parts: Array.isArray(raw.parts) ? raw.parts : [],
      chains: Array.isArray(raw.chains) ? raw.chains : [],
    };
  } catch {
    return { parts: [], chains: [] };
  }
}

function writeStore(store) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, parts: store.parts, chains: store.chains }, null, 2)
  );
}

/** Normalise a harvested name into a readable part name. */
function normalizePart(raw) {
  let n = String(raw || '').trim();
  if (!n) return null;
  // "create_torso" / "make_head" -> "torso" / "head"
  n = n.replace(/^(create|make|build|add|new|gen|generate)_/i, '');
  n = n.replace(/[_\-.]+/g, ' ').trim();
  if (!n || IGNORED_NAMES.has(n.toLowerCase())) return null;
  if (n.length > 48) n = n.slice(0, 48);
  return n;
}

/**
 * Harvest part names out of a generated Blender script.
 *
 * Heuristic on purpose: MeshCoder output varies, so we look for the common
 * ways a script names things it creates.
 */
function extractParts(codePath) {
  let src = '';
  try {
    src = fs.readFileSync(codePath, 'utf8');
  } catch {
    return [];
  }
  const found = [];
  const patterns = [
    /\.name\s*=\s*["']([^"']+)["']/g,
    /new\s*\(\s*["']([^"']+)["']/g,
    /["']name["']\s*:\s*["']([^"']+)["']/g,
    /^\s*def\s+(?:create|make|build|add|part)_(\w+)/gim,
    /^\s*#\s*part[:\s]+(.+)$/gim,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = normalizePart(m[1]);
      if (name) found.push(name);
    }
  }
  return [...new Set(found)];
}

/**
 * Merge names that differ only by extra words, so "backrest panel" and
 * "backrest" become one library entry. Keeps the shortest name.
 */
function mergeDuplicates(store) {
  const byName = new Map(store.parts.map((p) => [p.name, p]));
  const dropped = [];
  for (const part of store.parts) {
    const words = part.name.split(' ').filter(Boolean);
    for (let i = words.length - 1; i >= 1; i -= 1) {
      const shorter = words.slice(0, i).join(' ');
      const target = byName.get(shorter);
      if (target && target !== part) {
        target.count += part.count || 1;
        target.updatedAt = Date.now();
        target.sources = [...new Set([...(target.sources || []), ...(part.sources || [])])];
        dropped.push(part);
        break;
      }
    }
  }
  if (dropped.length) {
    store.parts = store.parts.filter((p) => !dropped.includes(p));
  }
  return store;
}

/**
 * Add harvested parts to the library (idempotent per name).
 * Returns the updated library.
 */
function harvest(codePath, sourceLabel) {
  const names = extractParts(codePath);
  const store = readStore();
  const byName = new Map(store.parts.map((p) => [p.name, p]));
  for (const name of names) {
    const existing = byName.get(name);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.updatedAt = Date.now();
      existing.sources = [...new Set([...(existing.sources || []), sourceLabel].filter(Boolean))];
    } else {
      const part = {
        id: crypto.randomUUID(),
        name,
        count: 1,
        sources: sourceLabel ? [sourceLabel] : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.parts.push(part);
      byName.set(name, part);
    }
  }
  mergeDuplicates(store);
  store.parts.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  writeStore(store);
  return store;
}

/** The library, most-used parts first. */
function library() {
  const store = readStore();
  return {
    parts: [...store.parts].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    chains: store.chains,
  };
}

/**
 * Write a compound Blender script.
 *
 * The generated file is standalone and runnable in Blender 4.x. It:
 *   1. imports the source meshes as objects,
 *   2. re-executes the earlier generated scripts (so their objects are reused,
 *      not regenerated — that is where the compounding happens),
 *   3. groups everything under a master collection named after the build.
 */
function buildCompoundScript({ name, meshes, scripts, outDir }) {
  const dir = outDir ? path.resolve(outDir) : process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${name}.compound.py`);

  const meshLines = meshes.map((m, i) => {
    const rel = path.relative(dir, m.filePath).split(path.sep).join('/');
    const varName = `mesh_${i}`;
    return [
      `def _import_${varName}():`,
      `    path = _resolve(${JSON.stringify(rel)})`,
      `    ext = os.path.splitext(path)[1].lower()`,
      `    if ext in ('.glb', '.gltf'):`,
      `        bpy.ops.import_scene.gltf(filepath=path)`,
      `    elif ext == '.fbx':`,
      `        bpy.ops.import_scene.fbx(filepath=path)`,
      `    elif ext == '.obj':`,
      `        bpy.ops.wm.obj_import(filepath=path)`,
      `    elif ext == '.stl':`,
      `        bpy.ops.wm.stl_import(filepath=path)`,
      `    elif ext == '.ply':`,
      `        bpy.ops.wm.ply_import(filepath=path)`,
      `    else:`,
      `        bpy.ops.wm.append(filepath=path)`,
      `    return path`,
    ].join('\n');
  });

  const scriptLines = scripts.map((s, i) => {
    const rel = path.relative(dir, s.filePath).split(path.sep).join('/');
    return [
      `def _reuse_${i}():`,
      `    path = _resolve(${JSON.stringify(rel)})`,
      `    with open(path, 'r', encoding='utf-8') as fh:`,
      `        source = fh.read()`,
      `    # Re-execute the earlier script so its objects are re-used as-is.`,
      `    # __name__ is "__main__" so scripts guarded by the usual`,
      `    # "if __name__ == '__main__': main()" entry point still run.`,
      `    exec(compile(source, path, 'exec'), {'__name__': '__main__', '__file__': path})`,
    ].join('\n');
  });

  const body = `#!/usr/bin/env python3
"""Compound build: ${name}

Generated by the Hunyuan3D compounding engine. Re-uses previously generated
scripts instead of regenerating them, so each build accumulates on the last.

Run inside Blender 4.x:  blender --python ${path.basename(outPath)}
"""
import os
import bpy

BUILD_NAME = ${JSON.stringify(name)}

# Resolve a path relative to this script's own folder. (bpy.path.abspath
# resolves against the .blend file, which may be a different directory.)
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def _resolve(rel):
    if os.path.isabs(rel):
        return rel
    return os.path.normpath(os.path.join(_SCRIPT_DIR, rel))

${[...meshLines, ...scriptLines].join('\n\n')}


def _make_collection():
    coll = bpy.data.collections.get(BUILD_NAME)
    if coll is None:
        coll = bpy.data.collections.new(BUILD_NAME)
        bpy.context.scene.collection.children.link(coll)
    return coll


def main():
    coll = _make_collection()
    before = set(bpy.data.objects)

${[...meshes.map((_, i) => `    _import_mesh_${i}()`), ...scripts.map((_, i) => `    _reuse_${i}()`)].join('\n')}

    # Move everything new into the build collection.
    for obj in set(bpy.data.objects) - before:
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        coll.objects.link(obj)

    print(f"[compound] {BUILD_NAME}: {len(coll.objects)} object(s) in collection")
    return coll


main()
`;

  fs.writeFileSync(outPath, body, 'utf8');
  return outPath;
}

/**
 * Compound a workspace: import its tracked meshes and re-use the scripts
 * already generated for it, then write the result next to the workspace.
 */
function compoundWorkspace(workspaceId, options = {}) {
  const ws = workspaceId ? workspaces.find(workspaceId) : workspaces.active();
  const scope = ws ? ws.id : null;
  const all = assets.list(scope);
  const meshes = all.filter((a) => a.kind === 'model' && a.exists);
  const scripts = chainFor(scope);

  if (!meshes.length && !scripts.length) {
    throw new Error('Nothing to compound yet — convert a mesh first.');
  }

  const base = options.name || (ws ? ws.name.replace(/[^\w.-]+/g, '_') : 'scene');
  const outDir = ws && ws.folder ? ws.folder : path.dirname(meshes[0] ? meshes[0].filePath : scripts[0].filePath);
  const outPath = buildCompoundScript({
    name: base,
    meshes,
    scripts,
    outDir,
  });

  // Register the compound script as an asset so it shows up in the sidebar.
  const record = assets.linkCode(outPath, meshes.length ? meshes[0].id : null);
  // Flag it so later builds skip it (see chainFor).
  assets.patch(record.id, { compound: true });

  // Remember the build so the sidebar can show the chain.
  const store = readStore();
  store.chains = [
    {
      id: crypto.randomUUID(),
      name: base,
      filePath: outPath,
      workspaceId: scope,
      meshCount: meshes.length,
      scriptCount: scripts.length,
      createdAt: Date.now(),
    },
    ...store.chains,
  ].slice(0, 50);
  writeStore(store);

  return { filePath: outPath, meshes: meshes.length, scripts: scripts.length, record };
}

/**
 * Previously generated scripts in the given workspace — the work a new
 * compound build re-uses instead of regenerating.
 *
 * Compound scripts themselves are excluded: re-executing one would replay a
 * whole previous build, and the chain would grow without bound.
 */
function chainFor(workspaceId) {
  return assets
    .list(workspaceId || null)
    .filter(
      (a) =>
        a.kind === 'blender-code' &&
        a.exists &&
        !a.compound &&
        !a.filePath.endsWith('.compound.py')
    );
}

module.exports = {
  harvest,
  library,
  chainFor,
  extractParts,
  compoundWorkspace,
  buildCompoundScript,
  storePath,
};

