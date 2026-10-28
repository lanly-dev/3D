// Hidden worker page for "Prepare for Mixamo upload": loads a model file
// with the same loaders as the viewer and re-exports its geometry as OBJ
// text (Mixamo's character upload accepts OBJ and only needs the mesh —
// it adds its own skeleton and skinning). The main process polls
// window.__exportStatus and reads window.__exportObj when done.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

window.__exportStatus = '';
window.__exportObj = null;
window.__exportError = null;

const filePath = new URLSearchParams(window.location.search).get('file') || '';

function extOf(p) {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function done(obj) {
  try {
    obj.updateMatrixWorld(true);
    // Rigging only needs geometry; a plain material keeps the OBJ free of
    // texture references Mixamo would ask for.
    obj.traverse((o) => {
      if (o.isMesh) o.material = new THREE.MeshBasicMaterial();
    });
    window.__exportObj = new OBJExporter().parse(obj);
    window.__exportStatus = 'ok';
  } catch (e) {
    window.__exportError = String(e && e.message ? e.message : e);
    window.__exportStatus = 'error';
  }
}

function fail(e) {
  window.__exportError = String(e && e.message ? e.message : e);
  window.__exportStatus = 'error';
}

(async () => {
  try {
    if (!filePath) throw new Error('no file given');
    let data = await window.viewerApi.readFile(filePath);
    if (data && !(data instanceof ArrayBuffer)) {
      data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    const ext = extOf(filePath);
    if (ext === 'glb' || ext === 'gltf') {
      const input = ext === 'gltf' ? new TextDecoder().decode(data) : data;
      new GLTFLoader().parse(input, '', (gltf) => done(gltf.scene), fail);
    } else if (ext === 'obj') {
      done(new OBJLoader().parse(new TextDecoder().decode(data)));
    } else if (ext === 'stl') {
      const geo = new STLLoader().parse(data);
      done(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    } else if (ext === 'ply') {
      const geo = new PLYLoader().parse(data);
      if (!geo.index) throw new Error('point-cloud PLY has no faces to export');
      done(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    } else if (ext === 'fbx') {
      done(new FBXLoader().parse(data, ''));
    } else {
      throw new Error('unsupported format: .' + ext);
    }
  } catch (e) {
    fail(e);
  }
})();
