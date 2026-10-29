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
const hemiLight = scene.children.find((c) => c.isHemisphereLight);
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
let darkTheme = true;
let ambientIntensity = darkTheme ? 1.0 : 3.0;
let parts = []; // { name, mesh, visible }
let highlightedPart = null;

function setTheme(dark) {
  darkTheme = dark;
  document.body.dataset.theme = dark ? 'dark' : 'light';
  scene.background = new THREE.Color(dark ? 0x14161b : 0x8c929c);
  fillLight.intensity = dark ? 0.6 : 1;
  keyLight.intensity = dark ? 2 : 1.4;
}

function setAmbient(delta) {
  ambientIntensity = Math.min(15, Math.max(0, ambientIntensity + delta));
  hemiLight.intensity = ambientIntensity;
  updateAmbientLabel();
  setStatus(`Ambient light: ${ambientIntensity.toFixed(1)}`);
}

function updateAmbientLabel() {
  document.getElementById('ambientLabel').textContent = `Ambient ${ambientIntensity.toFixed(1)}`;
}

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

// Textures off = inspect the bare geometry (the "white model" look).
// Every texture slot (map, normalMap, roughnessMap, ...) is stashed and
// nulled, then restored verbatim — nothing about the model is modified.
let texturesOn = true;
const stashedMaps = new Map(); // material -> { prop: texture }

function setTextures(root, on) {
  const seen = new Set();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (seen.has(m)) return;
      seen.add(m);
      if (!on) {
        const saved = {};
        for (const key of Object.keys(m)) {
          if (m[key] && m[key].isTexture) {
            saved[key] = m[key];
            m[key] = null;
          }
        }
        if (Object.keys(saved).length) {
          stashedMaps.set(m, saved);
          m.needsUpdate = true; // toggling a map changes the shader defines
        }
      } else {
        const saved = stashedMaps.get(m);
        if (saved) {
          Object.assign(m, saved);
          stashedMaps.delete(m);
          m.needsUpdate = true;
        }
      }
    });
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

// Animation playback (FBX and GLB files can carry clips — Mixamo
// downloads always do). A mixer over the loaded object; the render loop
// below advances it while it plays.
let mixer = null;
let action = null;
let modelClips = [];
const animBar = document.getElementById('animbar');
const animPlayBtn = document.getElementById('anim-play');
const animClipSel = document.getElementById('anim-clip');
const animTimeEl = document.getElementById('anim-time');
const animClock = new THREE.Clock();

function playClip(index) {
  if (!mixer || !modelClips.length) return;
  if (action) action.stop();
  action = mixer.clipAction(modelClips[index]);
  action.reset().play();
  animPlayBtn.innerHTML = '&#10074;&#10074;';
  animTimeEl.textContent = `0.0s / ${modelClips[index].duration.toFixed(1)}s`;
}

animPlayBtn.addEventListener('click', () => {
  if (!action) return;
  action.paused = !action.paused;
  animPlayBtn.innerHTML = action.paused ? '&#9654;' : '&#10074;&#10074;';
});
animClipSel.addEventListener('change', () => playClip(Number(animClipSel.value)));

function showObject(obj, anims) {
  if (model) scene.remove(model);
  if (highlightedPart) {
    unhighlightPart(highlightedPart);
    highlightedPart = null;
  }
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
    action = null;
  }
  modelClips = Array.isArray(anims) ? anims : [];
  model = obj;
  scene.add(obj);
  fitCamera(obj);
  window.__viewerStatus = 'ok';
  collectParts(obj);
  if (modelClips.length) {
    mixer = new THREE.AnimationMixer(obj);
    animClipSel.innerHTML = '';
    modelClips.forEach((clip, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = clip.name || `Clip ${i + 1}`;
      animClipSel.appendChild(opt);
    });
    animBar.hidden = false;
    playClip(0);
    window.__viewerAnim = { clips: modelClips.length, playing: true };
    setStatus(`Loaded — playing animation (${modelClips.length} clip${modelClips.length === 1 ? '' : 's'})`);
  } else {
    animBar.hidden = true;
    window.__viewerAnim = null;
    setStatus('Loaded — drag to orbit, scroll to zoom, right-drag to pan');
  }
}

function collectParts(root) {
  parts = [];
  root.traverse((obj) => {
    if (obj.isMesh) {
      parts.push({
        name: obj.name || `Part ${parts.length + 1}`,
        mesh: obj,
        visible: obj.visible,
      });
    }
  });
  renderPartsList();
}

function renderPartsList() {
  const list = document.getElementById('partsList');
  const count = document.getElementById('partsCount');
  const btn = document.getElementById('parts');
  list.innerHTML = '';
  count.textContent = `(${parts.length})`;
  btn.textContent = parts.length ? `Parts (${parts.length})` : 'Parts';
  if (!parts.length) {
    list.textContent = 'No parts';
    return;
  }
  parts.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'part-row' + (highlightedPart === p ? ' highlighted' : '');

    const vis = document.createElement('span');
    vis.className = 'part-vis' + (p.visible ? '' : ' hidden');
    vis.textContent = '👁';
    vis.title = 'Toggle visibility';

    const name = document.createElement('span');
    name.className = 'part-name' + (p.visible ? '' : ' hidden');
    name.textContent = p.name;
    name.title = p.name;

    row.appendChild(vis);
    row.appendChild(name);

    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      p.visible = !p.visible;
      p.mesh.visible = p.visible;
      vis.className = 'part-vis' + (p.visible ? '' : ' hidden');
      name.className = 'part-name' + (p.visible ? '' : ' hidden');
    });

    name.addEventListener('click', (e) => {
      e.stopPropagation();
      highlightPart(p);
    });

    list.appendChild(row);
  });
}

function highlightPart(p) {
  if (highlightedPart === p) {
    unhighlightPart(p);
    highlightedPart = null;
  } else {
    if (highlightedPart) unhighlightPart(highlightedPart);
    applyHighlight(p);
    highlightedPart = p;
  }
  renderPartsList();
  setStatus(highlightedPart ? `Highlighted: ${p.name}` : 'Selection cleared');
}

function applyHighlight(p) {
  p.mesh.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    // Clone materials so shared materials aren't affected
    const origMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const newMats = origMats.map((m) => {
      const clone = m.clone();
      if (clone.emissive) {
        clone.emissive.set(0x4c8dff);
        clone.emissiveIntensity = 0.6;
      } else if (clone.color) {
        clone.color.set(0x4c8dff);
      }
      clone.needsUpdate = true;
      return clone;
    });
    obj.__origMaterial = obj.material;
    obj.material = Array.isArray(obj.material) ? newMats : newMats[0];
  });
}

function unhighlightPart(p) {
  p.mesh.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (obj.__origMaterial) {
      obj.material = obj.__origMaterial;
      delete obj.__origMaterial;
    }
  });
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
      showObject(factory());
    } catch (e) {
      showError(e);
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
    showError(e);
    return;
  }
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const input = ext === 'gltf' ? new TextDecoder().decode(data) : data;
      new GLTFLoader().parse(
        input,
        '',
        (gltf) => showObject(gltf.scene, gltf.animations),
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
      const fbx = new FBXLoader().parse(data, '');
      showObject(fbx, fbx.animations);
    } else {
      showError('unsupported format: .' + ext);
    }
  } catch (e) {
    showError(e);
  }
}

document.getElementById('texture').addEventListener('click', (e) => {
  texturesOn = !texturesOn;
  if (model) setTextures(model, texturesOn);
  e.currentTarget.classList.toggle('active', texturesOn);
});
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
document.getElementById('parts').addEventListener('click', (e) => {
  const panel = document.getElementById('partsPanel');
  panel.classList.toggle('open');
  e.currentTarget.classList.toggle('active', panel.classList.contains('open'));
});
document.getElementById('theme').addEventListener('click', (e) => {
  setTheme(!darkTheme);
  e.currentTarget.classList.toggle('active', !darkTheme);
});
document.getElementById('ambientDown').addEventListener('click', () => {
  setAmbient(-1);
});
document.getElementById('ambientUp').addEventListener('click', () => {
  setAmbient(1);
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
  const dt = animClock.getDelta();
  if (mixer && action && !action.paused) {
    mixer.update(dt);
    animTimeEl.textContent = `${action.time.toFixed(1)}s / ${modelClips[Number(animClipSel.value)].duration.toFixed(1)}s`;
    if (window.__viewerAnim) window.__viewerAnim.time = action.time;
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();
load();
