// Thumbnail renderer: loads one model, frames it, renders a single frame,
// then reports readiness so the main process can capture the page.
// Same loaders and framing as the viewer, minus the toolbar and controls.
// GLB is fully self-contained; .gltf files with external textures or
// .bin files only render their geometry here. Converted code files
// (.ts/.js from glb2ts) are constructed by importing the module and
// calling its create…() factory, like the viewer does.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const filePath = new URLSearchParams(window.location.search).get('file') || '';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1e25);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 10000);
camera.position.set(2, 1.5, 3);

scene.add(new THREE.HemisphereLight(0xffffff, 0x30303a, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2);
keyLight.position.set(5, 8, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.6);
fillLight.position.set(-6, 3, -4);
scene.add(fillLight);

function fitCamera(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.8;
  camera.position.set(dist * 0.7, dist * 0.55, dist * 0.9);
  camera.near = Math.max(0.01, dist / 1000);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}

function done(ok, err) {
  if (ok) {
    renderer.render(scene, camera);
    window.__thumbStatus = 'ok';
  } else {
    console.error('thumbnail load failed', err);
    window.__thumbStatus = 'error';
    window.__thumbError = String(err && err.message ? err.message : err);
  }
}

function extOf(p) {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function collectTextures(root) {
  const texs = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      for (const key of Object.keys(m)) {
        if (m[key] && m[key].isTexture) texs.push(m[key]);
      }
    });
  });
  return texs;
}

// Record what the model carries — any material texture, and how many
// animation clips — for the sidebar's thumbnail badges. The main
// process reads window.__thumbMeta after a successful render and
// stores it alongside the thumbnail (thumbs.js). Detection is what the
// loaders actually produced: an .obj's MTL textures never load here
// (same as the viewer), so it reports tex:false like it renders.
function probe(root, clips) {
  window.__thumbMeta = { tex: collectTextures(root).length > 0, clips: clips || 0 };
}

// A constructed model's textures decode asynchronously; wait until
// every texture image has finished (or a short deadline) so the
// captured frame is the textured one, not the untextured first paint.
function waitForTextures(root) {
  const texs = collectTextures(root);
  if (!texs.length) return Promise.resolve();
  const deadline = Date.now() + 2500;
  return new Promise((resolve) => {
    const tick = () => {
      // A TextureLoader texture has no image at all until its load
      // finishes — that, or a still-loading image, means "not ready".
      const pending = texs.some((t) => !t.image || t.image.complete === false);
      if (!pending || Date.now() > deadline) resolve();
      else setTimeout(tick, 100);
    };
    tick();
  });
}

async function load() {
  if (!filePath) {
    done(false, 'no file given');
    return;
  }
  const ext = extOf(filePath);
  if (ext === 'ts' || ext === 'js' || ext === 'mjs') {
    // Converted code: the main process hands over JS (TypeScript already
    // transpiled); import it as a module and construct the model.
    try {
      const js = await window.viewerApi.readModule(filePath);
      const blobUrl = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      const mod = await import(blobUrl);
      const names = Object.keys(mod).filter((k) => /^create[A-Z]/.test(k) && typeof mod[k] === 'function');
      const factory = names.length ? mod[names[0]] : Object.values(mod).find((v) => typeof v === 'function');
      if (!factory) throw new Error('this file exports no create…() function');
      const obj = factory();
      scene.add(obj);
      probe(obj, (obj.animations || []).length);
      fitCamera(obj);
      await waitForTextures(obj);
      done(true);
    } catch (e) {
      done(false, e);
    }
    return;
  }
  let data;
  try {
    data = await window.viewerApi.readFile(filePath);
    // IPC may deliver the bytes as a Uint8Array instead of an ArrayBuffer;
    // the loaders need a clean ArrayBuffer.
    if (data && !(data instanceof ArrayBuffer)) {
      data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
  } catch (e) {
    done(false, e);
    return;
  }
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const input = ext === 'gltf' ? new TextDecoder().decode(data) : data;
      new GLTFLoader().parse(
        input,
        '',
        (gltf) => { scene.add(gltf.scene); probe(gltf.scene, (gltf.animations || []).length); fitCamera(gltf.scene); done(true); },
        (e) => done(false, e)
      );
    } else if (ext === 'obj') {
      const obj = new OBJLoader().parse(new TextDecoder().decode(data));
      scene.add(obj);
      probe(obj, 0);
      fitCamera(obj);
      done(true);
    } else if (ext === 'stl') {
      const mesh = new THREE.Mesh(
        new STLLoader().parse(data),
        new THREE.MeshStandardMaterial({ color: 0x9fb4d8, metalness: 0.1, roughness: 0.6 })
      );
      scene.add(mesh);
      probe(mesh, 0);
      fitCamera(mesh);
      done(true);
    } else if (ext === 'ply') {
      const geo = new PLYLoader().parse(data);
      const obj = geo.index
        ? new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: !!geo.getAttribute('color'), metalness: 0.1, roughness: 0.6 }))
        : new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.02, vertexColors: !!geo.getAttribute('color') }));
      scene.add(obj);
      probe(obj, 0);
      fitCamera(obj);
      done(true);
    } else if (ext === 'fbx') {
      const obj = new FBXLoader().parse(data, '');
      scene.add(obj);
      probe(obj, (obj.animations || []).length);
      fitCamera(obj);
      done(true);
    } else {
      done(false, 'unsupported format: .' + ext);
    }
  } catch (e) {
    done(false, e);
  }
}

load();
