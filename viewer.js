// In-app 3D viewer (module script, runs in the viewer window).
// Loads a model file through the preload bridge (never the network),
// centers it, and offers orbit / wireframe / rotate / grid / reset.
// GLB is fully self-contained; .gltf files with external textures or
// .bin files only load their geometry here.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const filePath = new URLSearchParams(window.location.search).get('file') || '';
const fileName = filePath.split(/[\\/]/).pop() || 'Model';
document.title = 'Viewer — ' + fileName;
document.getElementById('name').textContent = fileName;

const statusEl = document.getElementById('status');
const setStatus = (msg) => {
  statusEl.textContent = msg;
};

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161b);

const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.01, 10000);
camera.position.set(2, 1.5, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 1.5;

scene.add(new THREE.HemisphereLight(0xffffff, 0x30303a, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2);
keyLight.position.set(5, 8, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.6);
fillLight.position.set(-6, 3, -4);
scene.add(fillLight);

const grid = new THREE.GridHelper(20, 20, 0x3a4050, 0x232733);
scene.add(grid);

let model = null;
let wireframeOn = false;

function setWireframe(root, on) {
  root.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if ('wireframe' in m) m.wireframe = on;
      });
    }
  });
}

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
  controls.target.set(0, 0, 0);
  controls.update();
  grid.position.y = box.min.y - center.y - 0.001;
}

function showObject(obj) {
  if (model) scene.remove(model);
  model = obj;
  scene.add(obj);
  fitCamera(obj);
  setStatus('Loaded — drag to orbit, scroll to zoom, right-drag to pan');
  window.__viewerStatus = 'ok';
}

function showError(err) {
  console.error('viewer load failed', err);
  setStatus('Could not load this file: ' + (err && err.message ? err.message : err));
  window.__viewerStatus = 'error';
  window.__viewerError = String(err && err.message ? err.message : err);
}

function extOf(p) {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

async function load() {
  if (!filePath) {
    showError('no file given');
    return;
  }
  setStatus('Loading…');
  let data;
  try {
    data = await window.viewerApi.readFile(filePath);
    // IPC may deliver the bytes as a Uint8Array instead of an ArrayBuffer;
    // the loaders need a clean ArrayBuffer.
    if (data && !(data instanceof ArrayBuffer)) {
      data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
  } catch (e) {
    showError(e);
    return;
  }
  const ext = extOf(filePath);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const input = ext === 'gltf' ? new TextDecoder().decode(data) : data;
      new GLTFLoader().parse(
        input,
        '',
        (gltf) => showObject(gltf.scene),
        (e) => showError(e)
      );
    } else if (ext === 'obj') {
      showObject(new OBJLoader().parse(new TextDecoder().decode(data)));
    } else if (ext === 'stl') {
      const geo = new STLLoader().parse(data);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9fb4d8, metalness: 0.1, roughness: 0.6 }));
      showObject(mesh);
    } else if (ext === 'ply') {
      const geo = new PLYLoader().parse(data);
      let obj;
      if (geo.index) {
        const mat = new THREE.MeshStandardMaterial({ vertexColors: !!geo.getAttribute('color'), metalness: 0.1, roughness: 0.6 });
        obj = new THREE.Mesh(geo, mat);
      } else {
        const mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: !!geo.getAttribute('color') });
        obj = new THREE.Points(geo, mat);
      }
      showObject(obj);
    } else if (ext === 'fbx') {
      showObject(new FBXLoader().parse(data, ''));
    } else {
      showError('unsupported format: .' + ext);
    }
  } catch (e) {
    showError(e);
  }
}

document.getElementById('wireframe').addEventListener('click', (e) => {
  wireframeOn = !wireframeOn;
  if (model) setWireframe(model, wireframeOn);
  e.currentTarget.classList.toggle('active', wireframeOn);
});
document.getElementById('rotate').addEventListener('click', (e) => {
  controls.autoRotate = !controls.autoRotate;
  e.currentTarget.classList.toggle('active', controls.autoRotate);
});
document.getElementById('grid').addEventListener('click', (e) => {
  grid.visible = !grid.visible;
  e.currentTarget.classList.toggle('active', grid.visible);
});
document.getElementById('reset').addEventListener('click', () => {
  if (model) fitCamera(model);
});

window.addEventListener('resize', () => {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
load();
