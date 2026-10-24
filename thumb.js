// Thumbnail renderer: loads one model, frames it, renders a single frame,
// then reports readiness so the main process can capture the page.
// Same loaders and framing as the viewer, minus the toolbar and controls.
// GLB is fully self-contained; .gltf files with external textures or
// .bin files only render their geometry here.
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

async function load() {
  if (!filePath) {
    done(false, 'no file given');
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
  const ext = extOf(filePath);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const input = ext === 'gltf' ? new TextDecoder().decode(data) : data;
      new GLTFLoader().parse(
        input,
        '',
        (gltf) => { scene.add(gltf.scene); fitCamera(gltf.scene); done(true); },
        (e) => done(false, e)
      );
    } else if (ext === 'obj') {
      const obj = new OBJLoader().parse(new TextDecoder().decode(data));
      scene.add(obj);
      fitCamera(obj);
      done(true);
    } else if (ext === 'stl') {
      const mesh = new THREE.Mesh(
        new STLLoader().parse(data),
        new THREE.MeshStandardMaterial({ color: 0x9fb4d8, metalness: 0.1, roughness: 0.6 })
      );
      scene.add(mesh);
      fitCamera(mesh);
      done(true);
    } else if (ext === 'ply') {
      const geo = new PLYLoader().parse(data);
      const obj = geo.index
        ? new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: !!geo.getAttribute('color'), metalness: 0.1, roughness: 0.6 }))
        : new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.02, vertexColors: !!geo.getAttribute('color') }));
      scene.add(obj);
      fitCamera(obj);
      done(true);
    } else if (ext === 'fbx') {
      const obj = new FBXLoader().parse(data, '');
      scene.add(obj);
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
