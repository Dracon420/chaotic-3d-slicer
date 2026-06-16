import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { io } from 'socket.io-client';

// ─── State ───────────────────────────────────────────────────
const state = {
  bed: { x: 220, y: 220 },
  // Multi-object editor. `objects` holds every part on the bed; `sel` is the
  // selected index. The per-object fields below (rawGeometry, paintMap, …) always
  // MIRROR objects[sel] — saved back on every selection change — so all the
  // existing single-model code (paint, effects, slice) operates on the selection
  // unchanged. Each object: { raw, base, paintMap, hasPaint, topology, modelHeight,
  // baseName, meshDirty, serverName, mesh, tf:{posX,posY,rotX,rotY,rotZ,scale} }.
  objects: [],
  sel: -1,
  modelMesh: null, // THREE.Mesh of the loaded model
  serverName: null, // filename on the backend (needed to slice)
  socketId: null,
  lastGcode: null, // { gcode, url } of the most recent slice
  selectedTray: null, // chosen Canvas tray_id for a CC2 print
  selectedTrayInfo: null, // full tray info {type,color,name,...} of the chosen slot
  rawGeometry: null, // current working mesh (effects may subdivide it)
  baseGeometry: null, // pristine loaded mesh — effects always clip from this
  printers: [], // known/discovered printers
  trays: [], // last-synced Canvas tray list (colours/types)
  view: 'slicer', // active tab: slicer | paint | printers | settings
  activeTray: 1, // brush colour (0-based tray index; 0 = base/erase)
  paintTool: 'rotate', // 'rotate' (orbit) | 'brush' (drag) | 'face' (tap) | 'layer'
  paintMap: null, // Int8Array, one tray index per ORIGINAL mesh triangle
  hasPaint: false, // any non-base faces painted yet
  topology: null, // { neighbors:[[..]], normals:Float32Array } cached per model
  modelHeight: 0, // printed height (mm) of the oriented model, for layer mode
  baseName: 'model', // base filename for (re)uploads
  meshDirty: false, // rawGeometry was modified (layer clip) -> needs re-upload
  fxColorA: 0, // Effects: lower/base colour (tray index)
  fxColorB: 1, // Effects: upper/effect colour (tray index)
  interlock: false, // Interlock effect → slicer weaves the colour boundary
};

// ─── DOM ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const els = {
  canvas: $('#viewport'),
  status: $('#status'),
  fileInput: $('#fileInput'),
  modelName: $('#modelName'),
  objCount: $('#objCount'),
  objectList: $('#objectList'),
  cloneBtn: $('#cloneBtn'),
  arrangeBtn: $('#arrangeBtn'),
  deleteBtn: $('#deleteBtn'),
  saveName: $('#saveName'),
  posX: $('#posX'),
  posY: $('#posY'),
  rotX: $('#rotX'),
  rotY: $('#rotY'),
  rotZ: $('#rotZ'),
  scale: $('#scale'),
  posXOut: $('#posXOut'),
  posYOut: $('#posYOut'),
  rotXOut: $('#rotXOut'),
  rotYOut: $('#rotYOut'),
  rotZOut: $('#rotZOut'),
  scaleOut: $('#scaleOut'),
  sliceBtn: $('#sliceBtn'),
  resetBtn: $('#resetBtn'),
  sliceStats: $('#sliceStats'),
  statTime: $('#statTime'),
  statWeight: $('#statWeight'),
  statLayers: $('#statLayers'),
  log: $('#log'),
  panel: $('#panel'),
  panelHandle: $('#panelHandle'),
  bedTypeSel: $('#bedTypeSel'),
  machineSel: $('#machineSel'),
  processSel: $('#processSel'),
  filamentSel: $('#filamentSel'),
  bedTemp: $('#bedTemp'),
  nozzleTemp: $('#nozzleTemp'),
  printRow: $('#printRow'),
  printerSel: $('#printerSel'),
  printBtn: $('#printBtn'),
  filamentBar: $('#filamentBar'),
  filamentSlots: $('#filamentSlots'),
  filamentRefresh: $('#filamentRefresh'),
  paintEmptyHint: $('#paintEmptyHint'),
  paintModes: $('#paintModes'),
  paintPalette: $('#paintPalette'),
  fxControls: $('#fxControls'),
  fxType: $('#fxType'),
  fxApply: $('#fxApply'),
  fxPaletteA: $('#fxPaletteA'),
  fxPaletteB: $('#fxPaletteB'),
  fxRowFrom: $('#fxRowFrom'),
  fxRowTo: $('#fxRowTo'),
  layFrom: $('#layFrom'),
  layTo: $('#layTo'),
  layFromOut: $('#layFromOut'),
  layToOut: $('#layToOut'),
  paintFill: $('#paintFill'),
  paintClear: $('#paintClear'),
  paintHint: $('#paintHint'),
  // Printers page
  scanBtn: $('#scanBtn'),
  printerList: $('#printerList'),
  statusBtn: $('#statusBtn'),
  statusOut: $('#statusOut'),
  addName: $('#addName'),
  addHost: $('#addHost'),
  addType: $('#addType'),
  addSerial: $('#addSerial'),
  addCode: $('#addCode'),
  addPrinterBtn: $('#addPrinterBtn'),
  bambuFields: $('#bambuFields'),
  profileSel: $('#profileSel'),
  profileApply: $('#profileApply'),
  profileSave: $('#profileSave'),
  profileDelete: $('#profileDelete'),
  // Settings page — richer print settings
  setLayerHeight: $('#setLayerHeight'),
  setWalls: $('#setWalls'),
  setTopLayers: $('#setTopLayers'),
  setBottomLayers: $('#setBottomLayers'),
  setInfill: $('#setInfill'),
  infillOut: $('#infillOut'),
  setInfillPattern: $('#setInfillPattern'),
  setSupports: $('#setSupports'),
  setBrim: $('#setBrim'),
  setPrimeTower: $('#setPrimeTower'),
  setPrimeTowerWidth: $('#setPrimeTowerWidth'),
};

// ─── Three.js scene ──────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas: els.canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true, // so we can capture the canvas for the printer thumbnail
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// updateStyle:false — never write inline canvas width/height; CSS owns the
// display size (height:var(--view-split)). onResize sets the buffer to match.
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  5000
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // don't go under the bed
controls.minDistance = 50;
controls.maxDistance = 1200;
// Once the user orbits, stop auto-reframing so we don't fight their view.
let userOrbited = false;
controls.addEventListener('start', () => { userOrbited = true; });

// Lights
scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x10151c, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(120, 260, 160);
scene.add(key);

// A group that holds the bed visuals so we can rebuild it on resize/config.
let bedGroup = new THREE.Group();
scene.add(bedGroup);

// The model lives inside a group so position/rotation/scale stay independent.
const modelGroup = new THREE.Group();
scene.add(modelGroup);

const modelMaterial = new THREE.MeshStandardMaterial({
  color: 0x2f81f7,
  metalness: 0.15,
  roughness: 0.55,
  flatShading: false,
});

// Used when a multi-colour paint map exists — shows each face in its tray colour.
const paintMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness: 0.15,
  roughness: 0.6,
});
const raycaster = new THREE.Raycaster();

// ─── Build the print-bed grid ────────────────────────────────
function buildBed() {
  scene.remove(bedGroup);
  bedGroup = new THREE.Group();

  const { x: bx, y: by } = state.bed;

  // Solid plate just below the grid.
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(bx, by),
    new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.9, metalness: 0 })
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.2;
  bedGroup.add(plate);

  // 10 mm grid.
  const grid = new THREE.GridHelper(Math.max(bx, by), Math.round(Math.max(bx, by) / 10), 0x3b4654, 0x252c36);
  bedGroup.add(grid);

  // Bright outline around the printable area.
  const half = new THREE.Vector3(bx / 2, 0, by / 2);
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half.x, 0.02, -half.z),
      new THREE.Vector3(half.x, 0.02, -half.z),
      new THREE.Vector3(half.x, 0.02, half.z),
      new THREE.Vector3(-half.x, 0.02, half.z),
    ]),
    new THREE.LineBasicMaterial({ color: 0x2f81f7 })
  );
  bedGroup.add(border);

  // Origin corner marker (front-left = printer 0,0).
  const originDot = new THREE.Mesh(
    new THREE.SphereGeometry(2.5, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x3fb950 })
  );
  originDot.position.set(-bx / 2, 0, by / 2);
  bedGroup.add(originDot);

  scene.add(bedGroup);
  frameView();
}

// Position the camera + orbit pivot so the bed (and model) sit centred in the
// viewport, accounting for the canvas aspect (the viewport is a short top
// region now). The pivot is the model's mid-height so rotation feels natural —
// the model spins in place instead of swinging around an off-screen point.
function frameView() {
  const span = Math.max(state.bed.x, state.bed.y);
  const midH = (state.modelHeight || span * 0.15) / 2;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || 1;
  const halfExtent = span * 0.62; // bed half-width + margin to frame
  const distV = halfExtent / Math.tan(vfov / 2);
  const distH = halfExtent / (Math.tan(vfov / 2) * aspect);
  const dist = Math.max(distV, distH) * 1.05;
  controls.target.set(0, midH, 0);
  const dir = new THREE.Vector3(0.62, 0.7, 0.95).normalize();
  camera.position.copy(dir.multiplyScalar(dist)).add(controls.target);
  controls.update();
}

// ─── Map printer-bed coords <-> world coords ─────────────────
// Printer origin (0,0) sits at the front-left corner; bed is centered at
// the world origin. Printer X -> world X, printer Y -> world Z.
function bedToWorldX(px) {
  return px - state.bed.x / 2;
}
function bedToWorldZ(py) {
  return state.bed.y / 2 - py;
}

// Write a value into a number box unless the user is currently typing in it.
function setNum(num, val) {
  if (num && document.activeElement !== num) num.value = val;
}

// Two-way bind a range slider <-> a number box. The slider's own 'input' calls
// onChange (which writes the value back into the box via setNum); typing in the
// box moves the slider (clamped) and calls onChange.
function bindNumber(slider, num, onChange) {
  slider.addEventListener('input', onChange);
  num.addEventListener('input', () => {
    let v = parseFloat(num.value);
    if (Number.isNaN(v)) return;
    v = Math.min(+slider.max, Math.max(+slider.min, v));
    slider.value = v;
    onChange();
  });
}

// ─── Apply slider values to the model ────────────────────────
function applyTransform() {
  const posX = +els.posX.value;
  const posY = +els.posY.value;
  const scalePct = +els.scale.value;

  setNum(els.posXOut, posX);
  setNum(els.posYOut, posY);
  setNum(els.scaleOut, scalePct);

  // Each object carries its OWN position + scale (multiple parts on one bed), so
  // we transform the selected mesh, not the shared group. Rotation is baked into
  // the geometry (so the part re-seats on the bed).
  const mesh = state.modelMesh;
  if (mesh) {
    mesh.position.set(bedToWorldX(posX), 0, bedToWorldZ(posY));
    mesh.scale.setScalar(scalePct / 100);
  }
  const o = state.objects[state.sel];
  if (o) o.tf = { posX, posY, rotX: +els.rotX.value, rotY: +els.rotY.value, rotZ: +els.rotZ.value, scale: scalePct };
  updateSelectionBox();
}

// ─── Multi-object editor ─────────────────────────────────────
// A wire-frame box marks the selected part.
let selectionBox = null;
function updateSelectionBox() {
  if (selectionBox) { scene.remove(selectionBox); selectionBox.geometry.dispose(); selectionBox = null; }
  if (state.objects.length > 1 && state.modelMesh) {
    selectionBox = new THREE.BoxHelper(state.modelMesh, 0x2f81f7);
    scene.add(selectionBox);
  }
}

// Snapshot the live state.* (selected object's working data + slider transform)
// back into objects[sel], so nothing is lost when we switch selection.
function saveSelectedObject() {
  const o = state.objects[state.sel];
  if (!o) return;
  o.raw = state.rawGeometry; o.base = state.baseGeometry; o.paintMap = state.paintMap;
  o.hasPaint = state.hasPaint; o.topology = state.topology; o.modelHeight = state.modelHeight;
  o.baseName = state.baseName; o.meshDirty = state.meshDirty; o.serverName = state.serverName;
  o.mesh = state.modelMesh;
  o.tf = {
    posX: +els.posX.value, posY: +els.posY.value, rotX: +els.rotX.value,
    rotY: +els.rotY.value, rotZ: +els.rotZ.value, scale: +els.scale.value,
  };
}

// Load objects[i] into the live state.* + sliders and mark it selected.
function loadObjectIntoState(i) {
  const o = state.objects[i];
  if (!o) return;
  state.sel = i;
  state.rawGeometry = o.raw; state.baseGeometry = o.base; state.paintMap = o.paintMap;
  state.hasPaint = o.hasPaint; state.topology = o.topology; state.modelHeight = o.modelHeight;
  state.baseName = o.baseName; state.meshDirty = o.meshDirty; state.serverName = o.serverName;
  state.modelMesh = o.mesh;
  els.posX.value = o.tf.posX; els.posY.value = o.tf.posY;
  els.rotX.value = o.tf.rotX; els.rotY.value = o.tf.rotY; els.rotZ.value = o.tf.rotZ;
  els.scale.value = o.tf.scale;
  setNum(els.posXOut, o.tf.posX); setNum(els.posYOut, o.tf.posY);
  setNum(els.rotXOut, o.tf.rotX); setNum(els.rotYOut, o.tf.rotY); setNum(els.rotZOut, o.tf.rotZ);
  setNum(els.scaleOut, o.tf.scale);
}

function selectObject(i) {
  if (i === state.sel || !state.objects[i]) return;
  saveSelectedObject();
  loadObjectIntoState(i);
  updateSelectionBox();
  renderObjectList();
  updatePaintUI();
}

// Create a fresh object from a Z-up geometry, append it, select it, build its mesh.
function addObject(geo, name) {
  saveSelectedObject();
  const o = {
    raw: geo, base: geo.clone(),
    paintMap: new Int8Array(geo.getAttribute('position').count / 3),
    hasPaint: false, topology: null, modelHeight: 0, baseName: name || 'model',
    meshDirty: false, serverName: null, mesh: null,
    tf: { posX: state.bed.x / 2, posY: state.bed.y / 2, rotX: 0, rotY: 0, rotZ: 0, scale: 100 },
  };
  state.objects.push(o);
  loadObjectIntoState(state.objects.length - 1);
  rebuildOriented(); // builds + positions this object's mesh
  o.mesh = state.modelMesh;
  renderObjectList();
  return o;
}

function cloneSelectedObject() {
  const o = state.objects[state.sel];
  if (!o) { log('Load a model first.', 'err'); return; }
  saveSelectedObject();
  const copy = {
    raw: o.raw.clone(), base: o.base.clone(),
    paintMap: o.paintMap ? o.paintMap.slice() : null,
    hasPaint: o.hasPaint, topology: null, modelHeight: o.modelHeight,
    baseName: o.baseName, meshDirty: o.meshDirty, serverName: o.serverName, mesh: null,
    // offset the copy so it isn't hidden under the original
    tf: { ...o.tf, posX: Math.min(state.bed.x - 5, o.tf.posX + 20), posY: Math.min(state.bed.y - 5, o.tf.posY + 20) },
  };
  state.objects.push(copy);
  loadObjectIntoState(state.objects.length - 1);
  rebuildOriented();
  copy.mesh = state.modelMesh;
  renderObjectList();
  log(`Cloned “${copy.baseName}”. ${state.objects.length} parts on the bed.`, 'ok');
}

function deleteSelectedObject() {
  const o = state.objects[state.sel];
  if (!o) return;
  if (o.mesh) { modelGroup.remove(o.mesh); o.mesh.geometry.dispose(); }
  state.objects.splice(state.sel, 1);
  if (!state.objects.length) {
    // Back to empty bed.
    state.sel = -1; state.rawGeometry = null; state.baseGeometry = null; state.paintMap = null;
    state.hasPaint = false; state.modelMesh = null; state.serverName = null;
    els.modelName.textContent = 'no model'; els.sliceBtn.disabled = true;
    updateSelectionBox(); renderObjectList(); updatePaintUI();
    return;
  }
  state.sel = -1; // force reload
  loadObjectIntoState(Math.max(0, Math.min(state.objects.length - 1, 0)));
  updateSelectionBox(); renderObjectList(); updatePaintUI();
  log(`Deleted a part. ${state.objects.length} left.`, 'ok');
}

// Shelf-pack every object within the bed (centres each in its cell) and reposition.
function autoArrange() {
  if (!state.objects.length) return;
  saveSelectedObject();
  const gap = 6;
  const items = state.objects.map((o) => {
    const g = o.mesh.geometry; g.computeBoundingBox();
    const bb = g.boundingBox; const s = o.tf.scale / 100;
    return { o, w: (bb.max.x - bb.min.x) * s + gap, d: (bb.max.z - bb.min.z) * s + gap };
  });
  // Largest first packs tighter.
  items.sort((a, b) => b.w * b.d - a.w * a.d);
  let x = 0, y = 0, rowD = 0;
  for (const it of items) {
    if (x + it.w > state.bed.x && x > 0) { x = 0; y += rowD; rowD = 0; }
    it.o.tf.posX = Math.min(state.bed.x - it.w / 2, x + it.w / 2);
    it.o.tf.posY = Math.min(state.bed.y - it.d / 2, y + it.d / 2);
    x += it.w; rowD = Math.max(rowD, it.d);
  }
  positionAllMeshes();
  // refresh sliders for the (still) selected object
  const o = state.objects[state.sel];
  if (o) { els.posX.value = o.tf.posX; els.posY.value = o.tf.posY; setNum(els.posXOut, o.tf.posX); setNum(els.posYOut, o.tf.posY); }
  updateSelectionBox();
  log(`Auto-arranged ${state.objects.length} part(s).`, 'ok');
}

// Push every object's tf position/scale onto its mesh.
function positionAllMeshes() {
  for (const o of state.objects) {
    if (!o.mesh) continue;
    o.mesh.position.set(bedToWorldX(o.tf.posX), 0, bedToWorldZ(o.tf.posY));
    o.mesh.scale.setScalar(o.tf.scale / 100);
  }
}

// Small list of parts under the controls; tap to select, ✕ to remove.
function renderObjectList() {
  const host = els.objectList;
  if (!host) return;
  // Single source of truth for the header label.
  const n = state.objects.length;
  els.modelName.textContent = n === 0 ? 'no model' : n === 1 ? state.objects[0].baseName : `${n} parts`;
  host.innerHTML = '';
  host.hidden = n < 2; // only show the list once there's more than one part
  state.objects.forEach((o, i) => {
    const row = document.createElement('div');
    row.className = 'obj-row' + (i === state.sel ? ' obj-row--sel' : '');
    const label = document.createElement('span');
    label.className = 'obj-row__name';
    label.textContent = `${i + 1}. ${o.baseName}`;
    label.addEventListener('click', () => selectObject(i));
    const del = document.createElement('button');
    del.className = 'obj-row__del'; del.textContent = '✕'; del.title = 'Remove this part';
    del.addEventListener('click', (e) => { e.stopPropagation(); selectObject(i); deleteSelectedObject(); });
    row.appendChild(label); row.appendChild(del);
    host.appendChild(row);
  });
  if (els.objCount) els.objCount.textContent = state.objects.length > 1 ? `${state.objects.length} parts` : '';
}

// ─── Model loading (STL / 3MF / OBJ) ─────────────────────────
const stlLoader = new STLLoader();
const stlExporter = new STLExporter();

// Export the current rawGeometry to STL and upload it (used after a layer clip
// modifies the mesh — the server must slice the same triangles the paintMap
// is keyed to). Updates state.serverName.
async function uploadCurrentMesh() {
  const stl = stlExporter.parse(new THREE.Mesh(state.rawGeometry), { binary: true });
  const form = new FormData();
  form.append('model', new Blob([stl], { type: 'application/octet-stream' }), `${state.baseName || 'model'}.stl`);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  state.serverName = (await res.json()).name;
  state.meshDirty = false;
}

// Bake one object's transform (rotation, scale, bed placement) into geometry in
// the slicer's Z-up frame, centred so the whole group sits around the bed centre.
function bakedZupGeometry(o) {
  const g = o.raw.clone();
  g.rotateX(THREE.MathUtils.degToRad(o.tf.rotX));
  g.rotateY(THREE.MathUtils.degToRad(o.tf.rotY));
  g.rotateZ(THREE.MathUtils.degToRad(o.tf.rotZ));
  const s = o.tf.scale / 100;
  g.scale(s, s, s);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const cx = (bb.max.x + bb.min.x) / 2;
  const cy = (bb.max.y + bb.min.y) / 2;
  g.translate(-cx, -cy, -bb.min.z); // centre XY, base at Z=0
  // place at bed position, relative to bed centre (group ends up centred on origin)
  g.translate(o.tf.posX - state.bed.x / 2, o.tf.posY - state.bed.y / 2, 0);
  return g.toNonIndexed();
}

// Merge all objects into one STL and upload it; returns the server filename.
async function uploadMergedObjects() {
  const parts = state.objects.map(bakedZupGeometry);
  const merged = parts.length === 1 ? parts[0] : BufferGeometryUtils.mergeGeometries(parts, false);
  merged.computeVertexNormals();
  const stl = stlExporter.parse(new THREE.Mesh(merged), { binary: true });
  const form = new FormData();
  const name = (els.saveName.value.trim() || state.objects[0].baseName || 'plate').replace(/[^a-zA-Z0-9 ._-]/g, '');
  form.append('model', new Blob([stl], { type: 'application/octet-stream' }), `${name}.stl`);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).name;
}

// Merge every mesh in a loaded object into one position-only geometry, baked
// into world space. Used for 3MF/OBJ (which arrive as a Group/scene).
function mergeObjectGeometry(object3d) {
  object3d.updateMatrixWorld(true);
  const parts = [];
  object3d.traverse((c) => {
    if (c.isMesh && c.geometry?.getAttribute('position')) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', c.geometry.getAttribute('position').clone());
      if (c.geometry.index) g.setIndex(c.geometry.index.clone());
      g.applyMatrix4(c.matrixWorld);
      parts.push(g.toNonIndexed());
    }
  });
  if (!parts.length) throw new Error('No printable mesh found in file');
  const merged = parts.length === 1 ? parts[0] : BufferGeometryUtils.mergeGeometries(parts, false);
  merged.computeVertexNormals();
  return merged;
}

// Parse a file into a raw geometry in the slicer's coordinate frame (Z-up).
async function parseModel(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'stl') return stlLoader.parse(buf);
  if (ext === '3mf') {
    // Some 3MFs (component assemblies, beam-lattice, the Production extension)
    // make three.js's loader throw a cryptic "reading 'mesh'". Catch it and
    // give an actionable message instead of crashing the load.
    let obj;
    try {
      obj = new ThreeMFLoader().parse(buf);
    } catch (e) {
      throw new Error("This .3mf uses features the in-browser reader can't open. In your slicer, export it as STL (right-click the object → Export → STL) and load that.");
    }
    return mergeObjectGeometry(obj);
  }
  if (ext === 'obj') return mergeObjectGeometry(new OBJLoader().parse(new TextDecoder().decode(buf)));
  throw new Error(`Unsupported file type: .${ext}`);
}

// Display a (Z-up) geometry: clone it, tip it onto the Y-up bed, center it.
// Rebuild the displayed mesh from the raw geometry with the current rotation
// (X→Y→Z, in the slicer's frame), then tip it onto the bed and re-seat it so
// whichever face you rotated downward rests flat at Z=0. Mirrors the backend.
function rebuildOriented() {
  if (!state.rawGeometry) return;
  const rx = THREE.MathUtils.degToRad(+els.rotX.value);
  const ry = THREE.MathUtils.degToRad(+els.rotY.value);
  const rz = THREE.MathUtils.degToRad(+els.rotZ.value);
  setNum(els.rotXOut, els.rotX.value);
  setNum(els.rotYOut, els.rotY.value);
  setNum(els.rotZOut, els.rotZ.value);

  const geometry = state.rawGeometry.clone();
  geometry.rotateX(rx);
  geometry.rotateY(ry);
  geometry.rotateZ(rz); // orientation in the slicer (Z-up) frame
  geometry.rotateX(-Math.PI / 2); // tip Z-up -> display Y-up
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const cx = (bb.max.x + bb.min.x) / 2;
  const cz = (bb.max.z + bb.min.z) / 2;
  geometry.translate(-cx, -bb.min.y, -cz); // center on bed, base at Y=0
  geometry.computeVertexNormals();

  // Track printed height + keep the Layer-mode sliders ranged to it.
  state.modelHeight = bb.max.y - bb.min.y;
  if (els.layFrom) {
    const h = Math.max(1, +state.modelHeight.toFixed(1));
    els.layFrom.max = h; els.layTo.max = h;
    if (+els.layTo.value === 0 || +els.layTo.value > h) els.layTo.value = h;
    if (+els.layFrom.value > h) els.layFrom.value = 0;
    els.layFromOut.max = h; els.layToOut.max = h;
    setNum(els.layFromOut, (+els.layFrom.value).toFixed(1));
    setNum(els.layToOut, (+els.layTo.value).toFixed(1));
  }

  if (state.modelMesh) {
    modelGroup.remove(state.modelMesh);
    state.modelMesh.geometry.dispose();
  }
  const painted = applyPaintColors(geometry); // adds a colour attr if painting
  state.modelMesh = new THREE.Mesh(geometry, painted ? paintMaterial : modelMaterial);
  modelGroup.add(state.modelMesh);
  if (state.objects[state.sel]) state.objects[state.sel].mesh = state.modelMesh;
  applyTransform();
}

// Throttle rotation rebuilds to one per animation frame for smooth dragging.
let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuildOriented();
  });
}

// ─── Multi-colour painting ───────────────────────────────────
// The 4 brush colours by tray index (the physical Canvas slots), with sensible
// fallbacks when the printer hasn't reported colours.
function paintColors() {
  const fallback = ['#3f6fd1', '#d24b4b', '#3fb46b', '#d9c64a'];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const t = (state.trays || []).find((x) => x && x.trayId === i);
    out[i] = (t && t.color) || fallback[i];
  }
  return out;
}

// Colour the model only once faces are actually painted — so Clear visibly
// reverts to the plain model (not a flat base-tray colour).
function paintActive() {
  return state.hasPaint;
}

// On the Paint tab, Brush/Face tools take over single-finger drag for painting;
// Rotate/Layer leave the orbit controls active. Elsewhere, orbit is always on.
function applyPaintControlState() {
  const painting = state.view === 'paint' && (state.paintTool === 'brush' || state.paintTool === 'face');
  controls.enabled = !painting;
}

// Give the (non-indexed) display geometry a per-vertex colour from paintMap.
// Returns false (and adds nothing) when painting isn't in play.
function applyPaintColors(geometry) {
  if (!state.paintMap || !paintActive()) return false;
  const cols = paintColors().map((h) => new THREE.Color(h));
  const pos = geometry.getAttribute('position');
  const verts = pos.count; // 3 per triangle (non-indexed)
  const arr = new Float32Array(verts * 3);
  for (let f = 0; f < verts / 3; f++) {
    const c = cols[state.paintMap[f] | 0] || cols[0];
    for (let k = 0; k < 3; k++) {
      const vi = (f * 3 + k) * 3;
      arr[vi] = c.r; arr[vi + 1] = c.g; arr[vi + 2] = c.b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return true;
}

// Allocate a paint map sized to the loaded mesh (one entry per triangle).
function ensurePaintMap() {
  if (!state.rawGeometry) { log('Load a model first, then paint it.', 'err'); return false; }
  if (!state.paintMap) {
    const tris = state.rawGeometry.getAttribute('position').count / 3;
    state.paintMap = new Int8Array(tris);
  }
  return true;
}

// Raycast the model and paint the hit face with the active brush colour.
function paintFaceAt(clientX, clientY) {
  if (!state.modelMesh || !state.paintMap) return;
  const rect = els.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(state.modelMesh, false)[0];
  if (!hit || hit.faceIndex == null) return;
  const f = hit.faceIndex;
  if (state.paintMap[f] === state.activeTray) return;
  state.paintMap[f] = state.activeTray;
  if (state.activeTray > 0) state.hasPaint = true;
  const colAttr = state.modelMesh.geometry.getAttribute('color');
  if (colAttr) {
    const c = new THREE.Color(paintColors()[state.activeTray] || '#888');
    for (let k = 0; k < 3; k++) colAttr.setXYZ(f * 3 + k, c.r, c.g, c.b);
    colAttr.needsUpdate = true;
  } else {
    rebuildOriented(); // first paint stroke: switch to the colour material
  }
}

function buildPaintPalette() {
  els.paintPalette.innerHTML = '';
  const cols = paintColors();
  for (let i = 0; i < 4; i++) {
    const t = (state.trays || []).find((x) => x && x.trayId === i);
    const sw = document.createElement('div');
    sw.className = 'paint-swatch' + (i === state.activeTray ? ' active' : '');
    sw.innerHTML =
      `<div class="paint-swatch__dot" style="background:${cols[i]}"></div>` +
      `<div>#${i + 1}${i === 0 ? ' base' : ''}<br>${(t && t.type) || ''}</div>`;
    sw.addEventListener('click', () => {
      state.activeTray = i;
      [...els.paintPalette.children].forEach((c, idx) => c.classList.toggle('active', idx === i));
    });
    els.paintPalette.appendChild(sw);
  }
}

// Refresh the Paint tab: rebuild the palette from the live tray colours and
// show the "load a model" hint until a mesh is ready.
function updatePaintUI() {
  buildPaintPalette();
  buildFxPalettes(); // keep the Effects A/B colour pickers in sync with the trays
  if (els.paintEmptyHint) els.paintEmptyHint.hidden = !!state.rawGeometry;
}

els.paintFill.addEventListener('click', () => {
  if (!ensurePaintMap()) return;
  state.paintMap.fill(state.activeTray);
  // An explicit "fill all" always recolours the model — including slot #1,
  // which is paint-index 0. On a CC2 that slot is a real colour (e.g. black
  // PETG), so treating it as "no paint" made Fill-all look broken. Show it.
  state.hasPaint = true;
  rebuildOriented();
  const c = paintColors()[state.activeTray] || '#888';
  log(`Filled the whole model with slot #${state.activeTray + 1} (${c}).`, 'ok');
});
els.paintClear.addEventListener('click', () => {
  if (!state.baseGeometry) return;
  // Restore the pristine mesh (undo any effect subdivision) and wipe paint.
  state.rawGeometry = state.baseGeometry.clone();
  state.paintMap = new Int8Array(state.rawGeometry.getAttribute('position').count / 3);
  state.hasPaint = false;
  state.topology = null;
  state.meshDirty = true; // re-upload the clean mesh on next slice
  rebuildOriented();
  log('Paint cleared.', 'ok');
});

// Re-apply every face's colour from the paint map (after batch operations).
function recolorAll() {
  if (!state.modelMesh) return;
  const colAttr = state.modelMesh.geometry.getAttribute('color');
  if (!colAttr) { rebuildOriented(); return; } // no colour attr yet -> full rebuild
  const cols = paintColors().map((h) => new THREE.Color(h));
  const n = colAttr.count / 3;
  for (let f = 0; f < n; f++) {
    const c = cols[state.paintMap[f] | 0] || cols[0];
    for (let k = 0; k < 3; k++) colAttr.setXYZ(f * 3 + k, c.r, c.g, c.b);
  }
  colAttr.needsUpdate = true;
}

// Triangle adjacency (shared edges) + per-triangle normals from the raw
// (non-indexed) geometry. Cached per model; used by the Face flood-fill.
function buildTopology() {
  if (state.topology) return state.topology;
  const pos = state.rawGeometry.getAttribute('position');
  const nTri = pos.count / 3;
  const normals = new Float32Array(nTri * 3);
  const neighbors = Array.from({ length: nTri }, () => []);
  const edgeMap = new Map();
  const vk = (i) => `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let f = 0; f < nTri; f++) {
    const i0 = 3 * f, i1 = i0 + 1, i2 = i0 + 2;
    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[3 * f] = nx / len; normals[3 * f + 1] = ny / len; normals[3 * f + 2] = nz / len;
    const ka = vk(i0), kb = vk(i1), kc = vk(i2);
    for (const e of [ek(ka, kb), ek(kb, kc), ek(kc, ka)]) {
      const arr = edgeMap.get(e);
      if (arr) { for (const g of arr) { neighbors[f].push(g); neighbors[g].push(f); } arr.push(f); }
      else edgeMap.set(e, [f]);
    }
  }
  state.topology = { neighbors, normals };
  return state.topology;
}

// Flood-fill from a seed triangle across coplanar neighbours (normals within
// ~18°), painting them the active colour.
function floodFillFace(seed) {
  const { neighbors, normals } = buildTopology();
  const sx = normals[3 * seed], sy = normals[3 * seed + 1], sz = normals[3 * seed + 2];
  const COS = 0.95;
  const seen = new Uint8Array(neighbors.length);
  const stack = [seed];
  seen[seed] = 1;
  while (stack.length) {
    const f = stack.pop();
    state.paintMap[f] = state.activeTray;
    for (const g of neighbors[f]) {
      if (seen[g]) continue;
      const d = normals[3 * g] * sx + normals[3 * g + 1] * sy + normals[3 * g + 2] * sz;
      if (d >= COS) { seen[g] = 1; stack.push(g); }
    }
  }
  if (state.activeTray > 0) state.hasPaint = true;
}

function floodFillFaceAt(clientX, clientY) {
  if (!state.modelMesh || !state.paintMap) return;
  const rect = els.canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  ), camera);
  const hit = raycaster.intersectObject(state.modelMesh, false)[0];
  if (!hit || hit.faceIndex == null) return;
  floodFillFace(hit.faceIndex);
  recolorAll();
}

// Split a raw triangle by a horizontal cut level (in display-height space `d`),
// returning pieces that each lie fully below or fully above the level — so the
// colour change is a clean horizontal cut, not a diagonal along the triangle.
function splitTriByLevel(p, d, level) {
  if (d.every((x) => x <= level) || d.every((x) => x >= level)) return [{ p, d }];
  const bp = [], bd = [], ap = [], ad = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = d[i], dj = d[j];
    if (di <= level) { bp.push(p[i]); bd.push(di); }
    if (di >= level) { ap.push(p[i]); ad.push(di); }
    if ((di < level && dj > level) || (di > level && dj < level)) {
      const f = (level - di) / (dj - di);
      const ip = [p[i][0] + f * (p[j][0] - p[i][0]), p[i][1] + f * (p[j][1] - p[i][1]), p[i][2] + f * (p[j][2] - p[i][2])];
      bp.push(ip); bd.push(level); ap.push(ip); ad.push(level);
    }
  }
  const out = [];
  const fan = (poly, pd) => { for (let i = 1; i + 1 < poly.length; i++) out.push({ p: [poly[0], poly[i], poly[i + 1]], d: [pd[0], pd[i], pd[i + 1]] }); };
  fan(bp, bd); fan(ap, ad);
  return out;
}

// The orientation transform (rotations + Z-up→Y-up tip) — same as rebuildOriented.
function orientationMatrix() {
  const rx = THREE.MathUtils.degToRad(+els.rotX.value);
  const ry = THREE.MathUtils.degToRad(+els.rotY.value);
  const rz = THREE.MathUtils.degToRad(+els.rotZ.value);
  return new THREE.Matrix4()
    .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    .multiply(new THREE.Matrix4().makeRotationZ(rz))
    .multiply(new THREE.Matrix4().makeRotationY(ry))
    .multiply(new THREE.Matrix4().makeRotationX(rx));
}

// Midpoint-subdivide triangle pieces until every edge is < maxEdge (so surface
// patterns like checker/confetti form real cells, not per-triangle). Capped so a
// fine mesh + tiny cells can't explode.
function tessellatePieces(pieces, maxEdge, cap) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const elen = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let out = pieces;
  for (let pass = 0; pass < 7; pass++) {
    if (out.length >= cap) break;
    let any = false;
    const next = [];
    for (const pc of out) {
      const [a, b, c] = pc.p;
      if (next.length < cap && Math.max(elen(a, b), elen(b, c), elen(c, a)) > maxEdge) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push({ p: [a, ab, ca] }, { p: [ab, b, bc] }, { p: [ca, bc, c] }, { p: [ab, bc, ca] });
        any = true;
      } else next.push({ p: pc.p });
    }
    out = next;
    if (!any) break;
  }
  return out;
}

// CORE of the effects engine. Reads the ORIGINAL (baseGeometry) mesh so effects
// never compound, optionally tessellates (opts.tessellate = max edge mm), clips
// at printed-height planes for crisp boundaries, then colours each piece via
// assignFn(printedHeight, piece) -> tray index. Rebuilds rawGeometry + paintMap.
function clipAndPaint(levels, assignFn, opts = {}) {
  const src = state.baseGeometry || state.rawGeometry;
  if (!src) return 0;
  const pos = src.getAttribute('position');
  const nTri = pos.count / 3;
  let pieces = new Array(nTri);
  for (let f = 0; f < nTri; f++) {
    pieces[f] = { p: [
      [pos.getX(3 * f), pos.getY(3 * f), pos.getZ(3 * f)],
      [pos.getX(3 * f + 1), pos.getY(3 * f + 1), pos.getZ(3 * f + 1)],
      [pos.getX(3 * f + 2), pos.getY(3 * f + 2), pos.getZ(3 * f + 2)],
    ] };
  }
  if (opts.tessellate) pieces = tessellatePieces(pieces, opts.tessellate, opts.cap || 200000);

  // Printed height per vertex (after tessellation), and the base height.
  const M = orientationMatrix();
  const v = new THREE.Vector3();
  const dh = (xyz) => { v.set(xyz[0], xyz[1], xyz[2]).applyMatrix4(M); return v.y; };
  let minDh = Infinity;
  for (const pc of pieces) { pc.d = pc.p.map(dh); minDh = Math.min(minDh, pc.d[0], pc.d[1], pc.d[2]); }

  for (const L of levels.map((l) => l + minDh)) {
    const next = [];
    for (const pc of pieces) for (const c of splitTriByLevel(pc.p, pc.d, L)) next.push(c);
    pieces = next;
  }
  let painted = 0;
  for (const pc of pieces) {
    const h = (pc.d[0] + pc.d[1] + pc.d[2]) / 3 - minDh;
    pc.paint = assignFn(h, pc) | 0;
    if (pc.paint > 0) painted++;
  }

  const npos = new Float32Array(pieces.length * 9);
  const nmap = new Int8Array(pieces.length);
  pieces.forEach((pc, fi) => {
    for (let k = 0; k < 3; k++) {
      npos[fi * 9 + k * 3] = pc.p[k][0];
      npos[fi * 9 + k * 3 + 1] = pc.p[k][1];
      npos[fi * 9 + k * 3 + 2] = pc.p[k][2];
    }
    nmap[fi] = pc.paint;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(npos, 3));
  g.computeVertexNormals();
  state.rawGeometry = g;
  state.paintMap = nmap;
  state.topology = null;
  state.meshDirty = true;
  state.hasPaint = painted > 0;
  rebuildOriented();
  recolorAll();
  return pieces.length;
}

function centroidOf(pc) {
  return [
    (pc.p[0][0] + pc.p[1][0] + pc.p[2][0]) / 3,
    (pc.p[0][1] + pc.p[1][1] + pc.p[2][1]) / 3,
    (pc.p[0][2] + pc.p[1][2] + pc.p[2][2]) / 3,
  ];
}

// Deterministic 0..1 hash from a piece's centroid (stable speckle for fades).
function pieceHash(pc) {
  const c = centroidOf(pc);
  return Math.abs(Math.sin(c[0] * 12.9898 + c[2] * 78.233) * 43758.5453) % 1;
}

// Deterministic 0..1 hash keyed to which `cell`-sized 3D cell the piece is in —
// so every piece in the same cell gets the SAME value (uniform confetti dots).
function cellHash(pc, cell) {
  const c = centroidOf(pc);
  const ix = Math.floor(c[0] / cell), iy = Math.floor(c[1] / cell), iz = Math.floor(c[2] / cell);
  return Math.abs(Math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453) % 1;
}

// Apply the selected Effect with colours A/B and the height parameter(s).
function applyEffect() {
  if (!ensurePaintMap() || !state.rawGeometry) return;
  const A = state.fxColorA, B = state.fxColorB;
  const h0 = +els.layFrom.value, h1 = +els.layTo.value;
  const type = els.fxType.value;
  state.interlock = type === 'interlock';
  const trays = (state.trays || []).filter((t) => t && t.loaded).map((t) => t.trayId);
  const palette = trays.length ? trays : [0, 1, 2, 3];
  let faces = 0;
  if (type === 'clean') {
    // CLIP at the height for a crisp flat boundary.
    faces = clipAndPaint([h0], (h) => (h < h0 ? A : B));
    log(`Clean colour change at ${h0.toFixed(1)} mm.`, 'ok');
  } else if (type === 'interlock') {
    // NO clip — paint whole triangles by centroid so the boundary stays jagged/
    // toothed (the original interlocking look) + the slicer weaves it too.
    faces = clipAndPaint([], (h) => (h < h0 ? A : B));
    log(`Interlock seam at ${h0.toFixed(1)} mm (toothed boundary).`, 'ok');
  } else if (type === 'stripes') {
    const W = Math.max(0.4, h0);
    const levels = [];
    for (let z = W; z < state.modelHeight; z += W) levels.push(z);
    faces = clipAndPaint(levels, (h) => (Math.floor(h / W) % 2 === 0 ? A : B));
    log(`Stripes every ${W.toFixed(1)} mm.`, 'ok');
  } else if (type === 'rainbow') {
    // Cycle through ALL loaded trays in bands of W mm.
    const W = Math.max(0.4, h0);
    const levels = [];
    for (let z = W; z < state.modelHeight; z += W) levels.push(z);
    faces = clipAndPaint(levels, (h) => palette[Math.floor(h / W) % palette.length]);
    log(`Rainbow bands every ${W.toFixed(1)} mm across ${palette.length} colours.`, 'ok');
  } else if (type === 'fade') {
    const lo = Math.min(h0, h1), hi = Math.max(h0, h1);
    const levels = [lo, hi];
    const n = 12;
    for (let i = 1; i < n; i++) levels.push(lo + ((hi - lo) * i) / n);
    faces = clipAndPaint(levels, (h, pc) => {
      if (h <= lo) return A;
      if (h >= hi) return B;
      return pieceHash(pc) < (h - lo) / (hi - lo) ? B : A;
    });
    log(`Fade ${lo.toFixed(1)}→${hi.toFixed(1)} mm.`, 'ok');
  } else if (type === 'speckle') {
    // Confetti: random colour per CELL of size `dot` (tessellate so dots are
    // uniform, not triangle-shaped). Uses all loaded tray colours.
    const dot = Math.max(1, h0);
    faces = clipAndPaint([], (h, pc) => {
      const id = cellHash(pc, dot);
      return palette[Math.floor(id * palette.length) % palette.length];
    }, { tessellate: dot * 0.55 });
    log(`Confetti (~${dot.toFixed(1)} mm dots, ${palette.length} colours).`, 'ok');
  } else if (type === 'checker') {
    // 3D checkerboard of real squares (size = h0 mm) — tessellate to the cell.
    const C = Math.max(1, h0);
    faces = clipAndPaint([], (h, pc) => {
      const cen = centroidOf(pc);
      const s = Math.floor(cen[0] / C) + Math.floor(cen[1] / C) + Math.floor(cen[2] / C);
      return s % 2 === 0 ? A : B;
    }, { tessellate: C * 0.55 });
    log(`Checkerboard (~${C.toFixed(1)} mm squares).`, 'ok');
  }
  if (!faces) log('Effect produced no change — check the settings.', 'err');
}

// Pointer painting (only on the Paint tab): Brush = drag, Face = tap.
let painting = false;
const paintingActive = () => state.view === 'paint' && state.paintMap;
els.canvas.addEventListener('pointerdown', (e) => {
  if (!paintingActive()) return;
  if (state.paintTool === 'brush') { painting = true; paintFaceAt(e.clientX, e.clientY); }
  else if (state.paintTool === 'face') floodFillFaceAt(e.clientX, e.clientY);
});
els.canvas.addEventListener('pointermove', (e) => {
  if (paintingActive() && state.paintTool === 'brush' && painting) paintFaceAt(e.clientX, e.clientY);
});
window.addEventListener('pointerup', () => { painting = false; });

// Mode selector (Rotate / Brush / Face / Effects).
els.paintModes.addEventListener('click', (e) => {
  const btn = e.target.closest('.paint-mode');
  if (!btn) return;
  if (btn.dataset.tool !== 'rotate' && !ensurePaintMap()) return; // need a model to paint
  state.paintTool = btn.dataset.tool;
  [...els.paintModes.children].forEach((b) => b.classList.toggle('active', b === btn));
  els.fxControls.hidden = state.paintTool !== 'fx';
  els.paintPalette.hidden = state.paintTool === 'fx'; // effects use their own A/B palettes
  if (state.paintTool === 'fx') { buildFxPalettes(); updateFxRows(); }
  applyPaintControlState();
  if (state.rawGeometry && !state.modelMesh?.geometry.getAttribute('color')) rebuildOriented();
  els.paintHint.textContent = {
    rotate: 'Drag to orbit the view. Switch to Brush/Face/Effects to paint.',
    brush: 'Drag across the model to paint individual faces with the chosen colour.',
    face: 'Tap a flat face to flood-fill that whole surface.',
    fx: 'Pick an effect + the two colours + height, then Apply effect.',
  }[state.paintTool];
});

// Effect height controls (reused: From = main height/width, To = fade top).
function syncLayerOut() {
  setNum(els.layFromOut, (+els.layFrom.value).toFixed(1));
  setNum(els.layToOut, (+els.layTo.value).toFixed(1));
}
bindNumber(els.layFrom, els.layFromOut, syncLayerOut);
bindNumber(els.layTo, els.layToOut, syncLayerOut);
els.fxApply.addEventListener('click', applyEffect);

// Build the A (base) and B (effect) colour pickers from the tray colours.
function buildFxPalette(host, sel, set) {
  host.innerHTML = '';
  const cols = paintColors();
  for (let i = 0; i < 4; i++) {
    const t = (state.trays || []).find((x) => x && x.trayId === i);
    const sw = document.createElement('div');
    sw.className = 'paint-swatch' + (i === sel() ? ' active' : '');
    sw.innerHTML = `<div class="paint-swatch__dot" style="background:${cols[i]}"></div><div>#${i + 1}</div>`;
    sw.addEventListener('click', () => { set(i); [...host.children].forEach((c, idx) => c.classList.toggle('active', idx === i)); });
    host.appendChild(sw);
  }
}
function buildFxPalettes() {
  buildFxPalette(els.fxPaletteA, () => state.fxColorA, (i) => { state.fxColorA = i; });
  buildFxPalette(els.fxPaletteB, () => state.fxColorB, (i) => { state.fxColorB = i; });
}

// Show the right height rows + labels for the chosen effect.
function updateFxRows() {
  const type = els.fxType.value;
  const label = {
    clean: 'Change at', interlock: 'Change at', fade: 'From',
    stripes: 'Band', rainbow: 'Band', checker: 'Square', speckle: 'Dot',
  }[type] || 'Height';
  els.fxRowFrom.hidden = false; // every effect uses the From value (height/band/cell/dot)
  els.fxRowTo.hidden = type !== 'fade'; // only the fade range needs a "to"
  els.fxControls.querySelector('.fx-rowlbl').textContent = label;
}
els.fxType.addEventListener('change', updateFxRows);

// ─── File handling: instant local preview + background upload ─
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const baseName = file.name.replace(/\.[^.]+$/, '');
  if (!els.saveName.value.trim()) els.saveName.value = baseName;
  els.sliceBtn.disabled = true;

  // 1) Parse on the device for an instant preview (and to convert 3MF/OBJ), then
  //    ADD it as a new object on the bed (existing parts stay).
  let rawGeometry;
  try {
    rawGeometry = await parseModel(file);
    addObject(rawGeometry, baseName); // sets up state.* + builds the mesh
    els.modelName.textContent = state.objects.length > 1 ? `${state.objects.length} parts` : file.name;
    if (state.objects.length === 1) { userOrbited = false; frameView(); } // frame the first part
    updatePaintUI();
  } catch (err) {
    log(`Could not read model: ${err.message}`, 'err');
    return;
  }

  // 2) Upload this part for slicing. STL goes as-is; 3MF/OBJ are exported to STL
  //    here so the backend's STL pipeline (transform + slice) works for every
  //    format. The serverName lands on the just-added (selected) object.
  try {
    const form = new FormData();
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'stl') {
      form.append('model', file);
    } else {
      const stl = stlExporter.parse(new THREE.Mesh(rawGeometry), { binary: true });
      form.append('model', new Blob([stl], { type: 'application/octet-stream' }), `${baseName}.stl`);
      log(`Converted ${ext.toUpperCase()} → STL for slicing.`);
    }
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.serverName = data.name;
    const o = state.objects[state.sel]; if (o) o.serverName = data.name;
    els.sliceBtn.disabled = false;
    log(`Uploaded ${data.originalName} (${(data.size / 1024).toFixed(0)} KB).`, 'ok');
  } catch (err) {
    log(`Upload failed: ${err.message}`, 'err');
  }
  // allow re-selecting the same file again later
  e.target.value = '';
});

// Multi-object editor buttons.
els.cloneBtn.addEventListener('click', () => {
  cloneSelectedObject();
  els.modelName.textContent = state.objects.length > 1 ? `${state.objects.length} parts` : (state.baseName || 'no model');
});
els.arrangeBtn.addEventListener('click', autoArrange);
els.deleteBtn.addEventListener('click', () => {
  deleteSelectedObject();
  els.modelName.textContent = state.objects.length > 1 ? `${state.objects.length} parts` : (state.objects.length === 1 ? state.baseName : 'no model');
});

// ─── Sliders (each paired with a typeable number box) ────────
// Position/scale are cheap group transforms; rotation rebuilds the geometry.
bindNumber(els.posX, els.posXOut, applyTransform);
bindNumber(els.posY, els.posYOut, applyTransform);
bindNumber(els.scale, els.scaleOut, applyTransform);
bindNumber(els.rotX, els.rotXOut, queueRebuild);
bindNumber(els.rotY, els.rotYOut, queueRebuild);
bindNumber(els.rotZ, els.rotZOut, queueRebuild);

// Quick 90° tilt buttons — snap a face toward the bed.
for (const btn of document.querySelectorAll('.snap-btn')) {
  btn.addEventListener('click', () => {
    const el = { x: els.rotX, y: els.rotY, z: els.rotZ }[btn.dataset.axis];
    el.value = (parseInt(el.value, 10) + 90) % 360;
    rebuildOriented();
  });
}

els.resetBtn.addEventListener('click', () => {
  els.posX.value = state.bed.x / 2;
  els.posY.value = state.bed.y / 2;
  els.rotX.value = 0;
  els.rotY.value = 0;
  els.rotZ.value = 0;
  els.scale.value = 100;
  rebuildOriented();
});

// ─── Slice ───────────────────────────────────────────────────
els.sliceBtn.addEventListener('click', async () => {
  if (!state.objects.length) return;
  els.sliceBtn.disabled = true;
  els.sliceBtn.textContent = 'Slicing…';
  log('Requesting slice…');

  try {
    let body;
    if (state.objects.length > 1) {
      // Multi-part: bake every object (its rotation, scale, bed position) into a
      // single STL in the slicer's Z-up frame, upload it, and slice with a
      // neutral transform — the placement is already in the geometry.
      log(`Merging ${state.objects.length} parts…`);
      saveSelectedObject();
      const name = await uploadMergedObjects();
      body = sliceBody();
      body.name = name;
      body.posX = state.bed.x / 2; body.posY = state.bed.y / 2;
      body.rotX = 0; body.rotY = 0; body.rotZ = 0; body.scalePercent = 100;
      delete body.paintMap; // per-triangle paint maps don't survive the merge
    } else {
      // Layer painting clips the mesh — re-upload it so the server slices the
      // exact triangles the paint map is keyed to.
      if (state.meshDirty) { log('Uploading painted mesh…'); await uploadCurrentMesh(); }
      body = sliceBody();
    }
    const res = await fetch('/api/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Slice failed');
    log(`✅ Done: ${data.gcode}`, 'ok');
    offerDownload(data.url, data.gcode);
    state.lastGcode = { gcode: data.gcode, url: data.url };
    els.printBtn.disabled = !els.printerSel.value;
    renderSliceStats(data.stats);
  } catch (err) {
    log(`❌ ${err.message}`, 'err');
  } finally {
    els.sliceBtn.disabled = false;
    els.sliceBtn.textContent = 'Slice ▶';
  }
});

// Capture a 144x144 PNG for the printer icon by snapshotting the MAIN viewport
// (a separate offscreen WebGL renderer rendered blank on mobile). Hides the bed,
// renders the model, centre-crops the canvas to a square, and scales to 144.
function makeThumbnails() {
  if (!state.modelMesh) return null;
  try {
    const bedWasVisible = bedGroup.visible;
    bedGroup.visible = false;
    renderer.render(scene, camera);

    const src = renderer.domElement;
    const side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2;
    const sy = (src.height - side) / 2;

    const out = document.createElement('canvas');
    out.width = 144;
    out.height = 144;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#1c2129'; // solid bg so the icon is never a blank square
    ctx.fillRect(0, 0, 144, 144);
    ctx.drawImage(src, sx, sy, side, side, 0, 0, 144, 144);

    bedGroup.visible = bedWasVisible;
    renderer.render(scene, camera);

    return { '144x144': out.toDataURL('image/png').split(',')[1] };
  } catch {
    return null;
  }
}

// Sensible default temps by filament type (used for Canvas when the tray's
// own range isn't enough to pick a print temp).
function nozzleForType(type = '') {
  const t = type.toUpperCase();
  if (t.includes('PETG')) return 250;
  if (t.includes('ABS') || t.includes('ASA')) return 250;
  if (t.includes('PC')) return 270;
  if (t.includes('TPU')) return 230;
  if (t.includes('PA') || t.includes('NYLON') || t.includes('CF')) return 270;
  return 215; // PLA / default
}
function bedForType(type = '') {
  const t = type.toUpperCase();
  if (t.includes('PETG')) return 75;
  if (t.includes('ABS') || t.includes('ASA')) return 95;
  if (t.includes('PC')) return 100;
  if (t.includes('TPU')) return 40;
  if (t.includes('PA') || t.includes('NYLON') || t.includes('CF')) return 80;
  return 55; // PLA / default
}

// Build the slice request body from the current UI state.
function sliceBody() {
  const body = {
    name: state.serverName,
    socketId: state.socketId,
    posX: +els.posX.value,
    posY: +els.posY.value,
    rotX: +els.rotX.value,
    rotY: +els.rotY.value,
    rotZ: +els.rotZ.value,
    scalePercent: +els.scale.value,
  };
  if (els.saveName.value.trim()) body.filename = els.saveName.value.trim();
  // If targeting a CC2 (Canvas), slice with the 4-slot AMS structure declared.
  const sel = els.printerSel.selectedOptions[0];
  if (sel && sel.dataset.protocol === 'mqtt') {
    body.canvas = true;
    // Tell the server which Canvas tray this object should print on, so it
    // builds a 3MF assigning the object to that filament index (gcode -> T<tray>).
    if (state.selectedTray != null) body.selectedTray = state.selectedTray;
    // Send the 4 tray colours so the declared filaments carry them (the job
    // then shows the right colour_map in the printer's file list).
    if (Array.isArray(state.trays) && state.trays.length) {
      const fils = [];
      for (const t of state.trays) {
        if (t && Number.isInteger(t.trayId)) fils[t.trayId] = { colour: t.color, type: t.type, name: t.name };
      }
      body.canvasFilaments = fils;
    }
    // Multi-colour: send the per-triangle paint map (overrides the single tray).
    if (state.paintMap && state.paintMap.some((v) => v > 0)) {
      body.paintMap = Array.from(state.paintMap);
      body.interlock = state.interlock; // Interlock effect → weave the boundary
    }
  }
  if (els.bedTypeSel.value) body.bedType = els.bedTypeSel.value;
  if (els.machineSel.value) body.machine = els.machineSel.value;
  if (els.processSel.value) body.process = els.processSel.value;
  if (els.filamentSel.value) body.filament = els.filamentSel.value;
  if (els.bedTemp.value) body.bedTemp = +els.bedTemp.value;
  if (els.nozzleTemp.value) body.nozzleTemp = +els.nozzleTemp.value;

  // CC2: the gcode MUST match the filament physically in the chosen tray, or
  // the nozzle is too cool to feed it. Use the tray's temps (unless overridden).
  if (body.canvas && state.selectedTrayInfo) {
    const t = state.selectedTrayInfo;
    if (!body.nozzleTemp) {
      body.nozzleTemp = t.maxTemp ? Math.round(t.maxTemp) - 5 : nozzleForType(t.type);
    }
    if (!body.bedTemp) body.bedTemp = bedForType(t.type);
  }

  // Richer print settings (blank = use the preset's value).
  const ps = {};
  if (els.setLayerHeight.value) ps.layer_height = +els.setLayerHeight.value;
  if (els.setWalls.value) ps.wall_loops = +els.setWalls.value;
  if (els.setTopLayers.value) ps.top_shell_layers = +els.setTopLayers.value;
  if (els.setBottomLayers.value) ps.bottom_shell_layers = +els.setBottomLayers.value;
  if (+els.setInfill.value > 0) ps.sparse_infill_density = +els.setInfill.value;
  if (els.setInfillPattern.value) ps.sparse_infill_pattern = els.setInfillPattern.value;
  ps.enable_support = els.setSupports.checked; // always explicit
  if (els.setBrim.value) ps.brim_type = els.setBrim.value;
  // Prime/wipe tower only matters for multi-colour (painted) jobs.
  if (body.paintMap && body.paintMap.length) {
    ps.enable_prime_tower = els.setPrimeTower.checked;
    if (els.setPrimeTower.checked && els.setPrimeTowerWidth.value) ps.prime_tower_width = +els.setPrimeTowerWidth.value;
  } else if (body.canvas) {
    ps.enable_prime_tower = false; // single-colour Canvas: no swaps, skip the tower
  }
  body.printSettings = ps;

  const thumbs = makeThumbnails();
  if (thumbs) body.thumbnails = thumbs;
  return body;
}

// Fill the machine / process / filament dropdowns from the backend.
async function loadPresets() {
  let data;
  try {
    const res = await fetch('/api/presets');
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const fill = (sel, items, currentPath) => {
    sel.innerHTML = '';
    let lastSource = null;
    let group = sel;
    for (const item of items) {
      if (item.source !== lastSource) {
        group = document.createElement('optgroup');
        group.label = item.source === 'user' ? 'My presets' : 'Built-in';
        sel.appendChild(group);
        lastSource = item.source;
      }
      const opt = document.createElement('option');
      opt.value = item.path;
      opt.textContent = item.name;
      if (currentPath && item.path === currentPath) opt.selected = true;
      group.appendChild(opt);
    }
  };
  fill(els.machineSel, data.presets.machine, data.current.machine);
  fill(els.processSel, data.presets.process, data.current.process);
  fill(els.filamentSel, data.presets.filament, data.current.filament);
}

// Select the first option whose (lower-cased) name contains any `includes`
// term and none of the `excludes` terms. Returns true if one was found.
function pickPreset(sel, includes, excludes = []) {
  const opt = [...sel.options].find((o) => {
    const n = o.textContent.toLowerCase();
    return includes.some((s) => n.includes(s)) && !excludes.some((s) => n.includes(s));
  });
  if (opt) sel.value = opt.value;
  return !!opt;
}

// CRITICAL for the CC2 Canvas: the gcode must be sliced with the matching
// MACHINE preset — only the CC2 preset's start gcode carries the `M6211` Canvas
// load macro. Selecting the CC2 as the target printer must therefore switch the
// slicing presets to the CC2 set (machine/process/filament), or the slice falls
// back to the CC1 default and the Canvas never gets a load command.
function autoSelectPresetsForPrinter() {
  const opt = els.printerSel.selectedOptions[0];
  if (!opt) return;
  if (opt.dataset.protocol === 'mqtt') {
    // Centauri Carbon 2 (Canvas)
    pickPreset(els.machineSel, ['carbon 2', 'cc2']);
    pickPreset(els.processSel, ['cc2']);
    pickPreset(els.filamentSel, ['ecc2', 'cc2']);
  } else if (opt.dataset.protocol === 'bambu') {
    // Bambu (A1 mini etc.) — needs Bambu Studio / Orca presets to be installed.
    if (!pickPreset(els.machineSel, ['a1 mini', 'a1m'])) pickPreset(els.machineSel, ['bambu', 'a1', 'p1', 'x1']);
    pickPreset(els.processSel, ['a1', 'bbl', 'bambu']);
    pickPreset(els.filamentSel, ['bambu', 'bbl', 'generic pla']);
  } else {
    // Centauri Carbon 1 (no Canvas)
    pickPreset(els.machineSel, ['centauri carbon', 'carbon'], ['carbon 2', 'cc2']);
    pickPreset(els.processSel, ['@elegoo cc', 'cc '], ['cc2']);
    pickPreset(els.filamentSel, ['ecc', '@ecc'], ['ecc2', 'cc2']);
  }
}

// Load configured printers (with live online status) and render the UI.
async function loadPrinters() {
  try {
    const res = await fetch('/api/printers');
    if (res.ok) state.printers = (await res.json()).printers || [];
  } catch {
    /* keep whatever we had */
  }
  refreshPrinterUI();
}

// Merge a list of printers into state by host (scan results, etc.).
function mergePrinters(list) {
  for (const p of list) {
    const i = state.printers.findIndex((x) => x.host === p.host);
    if (i >= 0) state.printers[i] = { ...state.printers[i], ...p };
    else state.printers.push(p);
  }
}

// Rebuild the slicer dropdown + the Printers-page cards from state.printers.
function refreshPrinterUI() {
  const prev = els.printerSel.value;
  els.printerSel.innerHTML = '';
  for (const p of state.printers) {
    const opt = document.createElement('option');
    opt.value = p.host;
    opt.dataset.mainboardId = p.mainboardId || '';
    opt.dataset.protocol = p.protocol || 'sdcp';
    opt.textContent = `${p.name} (${p.host})`;
    els.printerSel.appendChild(opt);
  }
  if (prev) els.printerSel.value = prev;
  els.printRow.hidden = state.printers.length === 0;
  els.printBtn.disabled = !state.lastGcode || state.printers.length === 0;

  renderPrinterCards();
  loadFilament();
}

function renderPrinterCards() {
  els.printerList.innerHTML = '';
  if (!state.printers.length) {
    els.printerList.innerHTML = '<p class="hint">No printers yet — tap “Scan network”.</p>';
    return;
  }
  for (const p of state.printers) {
    const badge = { mqtt: 'CC2', sdcp: 'CC1', bambu: 'Bambu' }[p.protocol] || p.protocol;
    const card = document.createElement('div');
    card.className = 'printer-card' + (p.host === els.printerSel.value ? ' active' : '');
    card.innerHTML =
      `<span class="printer-card__dot ${p.online ? 'online' : ''}"></span>` +
      `<div class="printer-card__info">` +
      `<div class="printer-card__name">${p.name}</div>` +
      `<div class="printer-card__sub">${p.host} · ${p.protocol.toUpperCase()} · ${p.online ? 'online' : 'offline'}</div>` +
      `</div>` +
      `<span class="printer-card__badge">${badge}</span>` +
      `<button class="printer-card__del" title="Remove this printer">🗑</button>`;
    card.addEventListener('click', () => {
      els.printerSel.value = p.host;
      refreshPrinterUI();
      log(`Selected printer: ${p.name}`);
    });
    card.querySelector('.printer-card__del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${p.name}" (${p.host}) from the app?`)) return;
      try {
        const res = await fetch(`/api/printers/${encodeURIComponent(p.host)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'delete failed');
        state.printers = state.printers.filter((x) => x.host !== p.host);
        refreshPrinterUI();
        log(`Removed printer ${p.name}.`, 'ok');
      } catch (err) {
        log(`Could not remove printer: ${err.message}`, 'err');
      }
    });
    els.printerList.appendChild(card);
  }
}

// When a CC2 (mqtt) printer is selected, show its 4 Canvas filament slots.
async function loadFilament() {
  const opt = els.printerSel.selectedOptions[0];
  state.selectedTray = null;
  if (!opt || opt.dataset.protocol !== 'mqtt') {
    els.filamentBar.hidden = true;
    return;
  }
  els.filamentBar.hidden = false;
  els.filamentSlots.innerHTML = '<span style="font-size:11px;color:#8b949e">syncing…</span>';
  try {
    const q = new URLSearchParams({
      host: opt.value,
      protocol: opt.dataset.protocol || '',
      mainboardId: opt.dataset.mainboardId || '',
    });
    const res = await fetch(`/api/printer-filament?${q}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'sync failed');
    renderSlots(data.trays || []);
  } catch (err) {
    els.filamentSlots.innerHTML = `<span style="font-size:11px;color:#f85149">${err.message} (is the printer awake?)</span>`;
  }
}

function renderSlots(trays) {
  state.trays = trays; // keep the full tray list (colours/types) for slicing
  updatePaintUI(); // refresh the paint palette with the real tray colours
  els.filamentSlots.innerHTML = '';
  if (!trays.length) {
    els.filamentSlots.innerHTML = '<span style="font-size:11px;color:#8b949e">no slots reported</span>';
    return;
  }
  for (const t of trays) {
    const chip = document.createElement('div');
    chip.className = 'slot' + (t.loaded ? '' : ' empty');
    chip.innerHTML =
      `<div class="slot__swatch" style="background:${t.color || '#444'}"></div>` +
      `<div class="slot__name">#${t.trayId + 1}<br>${t.name || '—'}</div>`;
    if (t.loaded) {
      chip.addEventListener('click', () => {
        state.selectedTray = t.trayId;
        state.selectedTrayInfo = t;
        [...els.filamentSlots.children].forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        autoSelectFilament(t); // so the slice declares a filament matching this tray
      });
    }
    els.filamentSlots.appendChild(chip);
  }
}

// Match the chosen Canvas tray to a filament preset (by name, then type) so the
// sliced gcode's filament matches what's physically loaded — otherwise the
// printer rejects the Canvas load on a filament-type mismatch.
function autoSelectFilament(tray) {
  const opts = [...els.filamentSel.querySelectorAll('option')];
  const name = (tray.name || '').toLowerCase();
  const type = (tray.type || '').toLowerCase();
  const byName = name && opts.find((o) => o.textContent.toLowerCase().includes(name));
  const byType = type && opts.find((o) => o.textContent.toLowerCase().includes(type));
  const match = byName || byType;
  if (match) {
    els.filamentSel.value = match.value;
    log(`Filament set to "${match.textContent}" to match tray #${tray.trayId + 1} (${tray.type}).`);
  } else {
    log(`⚠ No filament preset matches tray #${tray.trayId + 1} (${tray.type}). Pick a matching one in Settings, or the Canvas may refuse to load.`, 'err');
  }
}

els.printerSel.addEventListener('change', () => {
  autoSelectPresetsForPrinter();
  renderPrinterCards();
  loadFilament();
  updatePaintUI();
});
els.filamentRefresh.addEventListener('click', loadFilament);

// ─── Tab navigation ──────────────────────────────────────────
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('view--active', v.id === `view-${name}`)
  );
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('tab--active', t.dataset.view === name)
  );
  applyPaintControlState(); // orbit on everywhere except Brush/Face on the Paint tab
  if (name === 'paint') updatePaintUI();
  // Switching into/out of Paint changes whether we show tray colours.
  if ((name === 'paint' || name === 'slicer') && state.rawGeometry) rebuildOriented();
  onResize(); // keep the 3D canvas sized correctly (viewport shows on slicer+paint)
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

// ─── Network scan (Printers page) ────────────────────────────
els.scanBtn.addEventListener('click', async () => {
  els.scanBtn.disabled = true;
  els.scanBtn.textContent = '🔍 Scanning…';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ socketId: state.socketId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    const found = data.printers || [];
    // Mark known printers offline if not in the scan, then merge the found ones.
    for (const p of state.printers) {
      if (!found.some((f) => f.host === p.host)) p.online = false;
    }
    mergePrinters(found);
    refreshPrinterUI();
    log(`Scan complete — ${found.length} printer(s) online.`, found.length ? 'ok' : '');
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'err');
  } finally {
    els.scanBtn.disabled = false;
    els.scanBtn.textContent = '🔍 Scan network for printers';
  }
});

// ─── Add / manage printers (Printers page) ───────────────────
els.addType.addEventListener('change', () => {
  els.bambuFields.hidden = els.addType.value !== 'bambu';
});
els.addPrinterBtn.addEventListener('click', async () => {
  const body = {
    name: els.addName.value.trim(),
    host: els.addHost.value.trim(),
    protocol: els.addType.value,
  };
  if (!body.host) { log('Enter the printer\'s IP address.', 'err'); return; }
  if (body.protocol === 'bambu') {
    body.serial = els.addSerial.value.trim();
    body.accessCode = els.addCode.value.trim();
    if (!body.serial || !body.accessCode) {
      log('Bambu printers need the serial number AND LAN access code.', 'err');
      return;
    }
  }
  els.addPrinterBtn.disabled = true;
  const oldLabel = els.addPrinterBtn.textContent;
  els.addPrinterBtn.textContent = body.protocol === 'mqtt' ? 'Adding… (contacting CC2)' : 'Adding…';
  try {
    const res = await fetch('/api/printers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'add failed');
    els.addName.value = ''; els.addHost.value = ''; els.addSerial.value = ''; els.addCode.value = '';
    await loadPrinters();
    const who = data.name || body.name || body.host;
    if (body.protocol === 'mqtt' && data.mqttReady === false) {
      // Added, but we couldn't read the CC2's MainboardID (asleep / wrong IP).
      addPrinterNote(`Added "${who}", but couldn't reach the CC2 to set it up. Make sure it's powered on and on this Wi‑Fi, then tap “Scan network”.`, 'warn');
    } else {
      addPrinterNote(`Added "${who}".`, 'ok');
    }
  } catch (err) {
    addPrinterNote(`Could not add printer: ${err.message}`, 'err');
  } finally {
    els.addPrinterBtn.disabled = false;
    els.addPrinterBtn.textContent = oldLabel;
  }
});

// Inline confirmation shown right under the Add-printer button, so the action
// is obviously acknowledged even though the main activity log lives elsewhere.
function addPrinterNote(text, kind) {
  let el = document.getElementById('addPrinterNote');
  if (!el) {
    el = document.createElement('p');
    el.id = 'addPrinterNote';
    el.className = 'hint';
    el.style.marginTop = '8px';
    els.addPrinterBtn.insertAdjacentElement('afterend', el);
  }
  el.textContent = text;
  el.style.color = kind === 'err' ? 'var(--err,#f85149)' : kind === 'warn' ? 'var(--warn,#d29922)' : 'var(--ok,#3fb950)';
  log(text, kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'info');
}

// ─── Saved settings profiles (Settings page) ─────────────────
// Everything the Settings page controls, captured/restored as one object.
function collectSettings() {
  return {
    machine: els.machineSel.value,
    process: els.processSel.value,
    filament: els.filamentSel.value,
    bedType: els.bedTypeSel.value,
    bedTemp: els.bedTemp.value,
    nozzleTemp: els.nozzleTemp.value,
    layerHeight: els.setLayerHeight.value,
    walls: els.setWalls.value,
    topLayers: els.setTopLayers.value,
    bottomLayers: els.setBottomLayers.value,
    infill: els.setInfill.value,
    infillPattern: els.setInfillPattern.value,
    supports: els.setSupports.checked,
    brim: els.setBrim.value,
    primeTower: els.setPrimeTower.checked,
    primeTowerWidth: els.setPrimeTowerWidth.value,
  };
}
function applySettings(s) {
  const set = (el, v) => { if (v !== undefined && v !== null) el.value = v; };
  set(els.machineSel, s.machine); set(els.processSel, s.process); set(els.filamentSel, s.filament);
  set(els.bedTypeSel, s.bedType); set(els.bedTemp, s.bedTemp); set(els.nozzleTemp, s.nozzleTemp);
  set(els.setLayerHeight, s.layerHeight); set(els.setWalls, s.walls);
  set(els.setTopLayers, s.topLayers); set(els.setBottomLayers, s.bottomLayers);
  set(els.setInfill, s.infill); set(els.setInfillPattern, s.infillPattern);
  els.setSupports.checked = !!s.supports;
  set(els.setBrim, s.brim);
  els.setPrimeTower.checked = s.primeTower !== false;
  set(els.setPrimeTowerWidth, s.primeTowerWidth);
}
async function loadProfiles(selectName) {
  try {
    const res = await fetch('/api/profiles');
    const { profiles } = await res.json();
    els.profileSel.innerHTML = '';
    if (!profiles.length) {
      els.profileSel.appendChild(new Option('(none saved yet)', ''));
    } else {
      for (const n of profiles) els.profileSel.appendChild(new Option(n, n));
      if (selectName) els.profileSel.value = selectName;
    }
  } catch { /* offline — leave as-is */ }
}
els.profileSave.addEventListener('click', async () => {
  const name = prompt('Save current settings as…', els.profileSel.value || 'My profile');
  if (!name || !name.trim()) return;
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), settings: collectSettings() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'save failed');
    await loadProfiles(name.trim());
    log(`Saved profile "${name.trim()}".`, 'ok');
  } catch (err) {
    log(`Could not save profile: ${err.message}`, 'err');
  }
});
els.profileApply.addEventListener('click', async () => {
  const name = els.profileSel.value;
  if (!name) return;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('profile not found');
    applySettings((await res.json()).settings);
    log(`Applied profile "${name}".`, 'ok');
  } catch (err) {
    log(`Could not apply profile: ${err.message}`, 'err');
  }
});
els.profileDelete.addEventListener('click', async () => {
  const name = els.profileSel.value;
  if (!name || !confirm(`Delete profile "${name}"?`)) return;
  try {
    await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadProfiles();
    log(`Deleted profile "${name}".`, 'ok');
  } catch (err) {
    log(`Could not delete profile: ${err.message}`, 'err');
  }
});

// On-demand printer status (Printers page).
els.statusBtn.addEventListener('click', async () => {
  const opt = els.printerSel.selectedOptions[0];
  if (!opt) { els.statusOut.textContent = 'Select a printer first (scan if needed).'; return; }
  if (opt.dataset.protocol !== 'mqtt') { els.statusOut.textContent = 'Live status is only available for CC2 (MQTT) printers.'; return; }
  els.statusBtn.disabled = true;
  els.statusOut.textContent = 'Querying printer…';
  try {
    const q = new URLSearchParams({ host: opt.value, protocol: 'mqtt', mainboardId: opt.dataset.mainboardId || '' });
    const res = await fetch(`/api/printer-status?${q}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    const s = data.status || {};
    if (s.reachable === false) { els.statusOut.textContent = `Unreachable: ${s.error || 'is the printer awake?'}`; return; }
    els.statusOut.textContent =
      `nozzle ${s.nozzle?.temp ?? '?'} → ${s.nozzle?.target ?? '?'} °C\n` +
      `bed ${s.bed?.temp ?? '?'} → ${s.bed?.target ?? '?'} °C\n` +
      `filament at nozzle: ${s.filamentDetected ? 'YES' : 'NO'}\n` +
      `active tray: ${s.activeTray ?? 'none'}\n` +
      `print state: ${s.printStatus ?? '?'}${s.printError ? ' · error ' + s.printError : ''}`;
  } catch (err) {
    els.statusOut.textContent = `Error: ${err.message}`;
  } finally {
    els.statusBtn.disabled = false;
  }
});

// Infill slider label (0 = use preset).
els.setInfill.addEventListener('input', () => {
  els.infillOut.textContent = +els.setInfill.value > 0 ? `${els.setInfill.value}%` : 'preset';
});

// Send the most recent slice to the selected printer, then start it.
els.printBtn.addEventListener('click', async () => {
  if (!state.lastGcode) return log('Slice something first.', 'err');
  const opt = els.printerSel.selectedOptions[0];
  if (!opt) return;
  const host = opt.value;
  const mainboardId = opt.dataset.mainboardId;
  const protocol = opt.dataset.protocol;

  // CC2: the gcode prints on tool T<tray> (the 3MF assigned the object to that
  // filament index), so slot_map maps gcode filament index <tray> -> the same
  // physical Canvas tray (1:1).
  // Match ElegooSlicer's start handshake exactly (captured from its MQTT): send
  // the FULL 4-tray identity slot_map (gcode filament index t -> physical tray
  // t), not just the one used tray. The object is assigned (in the 3MF) to
  // filament index = the chosen tray, so identity routing pulls from that tray.
  let slotMap;
  if (opt.dataset.protocol === 'mqtt' && state.selectedTray != null) {
    slotMap = [0, 1, 2, 3].map((i) => ({ canvas_id: 0, t: i, tray_id: i }));
  }
  const trayNote =
    state.selectedTray != null ? `\nUsing Canvas slot #${state.selectedTray + 1}.` : '';

  if (!confirm(`Send "${state.lastGcode.gcode}" to ${opt.textContent} and START printing?${trayNote}\n\nMake sure the build plate is clear.`)) {
    return;
  }

  els.printBtn.disabled = true;
  els.printBtn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gcode: state.lastGcode.gcode,
        host,
        protocol,
        mainboardId,
        socketId: state.socketId,
        start: true,
        slotMap,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    if (data.started) {
      log('🖨️ Print started on the printer!', 'ok');
    } else if (data.needsPanel && data.message) {
      // CC1 staged the file but wants you to confirm Side A/B + Print on the panel.
      log(`📲 ${data.message}`, 'ok');
    } else {
      log('✅ Uploaded to printer.', 'ok');
    }
  } catch (err) {
    log(`❌ ${err.message}`, 'err');
  } finally {
    els.printBtn.disabled = false;
    els.printBtn.textContent = 'Send ⤴';
  }
});

function offerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = `⤓ Download ${name}`;
  a.style.cssText = 'display:block;color:#3fb950;margin-top:8px;font-size:13px;';
  els.log.appendChild(a);
}

// Slicer-style estimate after a slice: print time / filament weight / layers.
function renderSliceStats(s) {
  if (!s) { els.sliceStats.hidden = true; return; }
  els.statTime.textContent = s.time || '—';
  els.statWeight.textContent = s.weightG ? `${s.weightG} g` : (s.lengthM ? `${s.lengthM} m` : '—');
  els.statLayers.textContent = s.layers || '—';
  els.sliceStats.hidden = false;
}

// ─── Logging helper ──────────────────────────────────────────
function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

// ─── Socket.io (live slicer logs) ────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  state.socketId = socket.id;
  els.status.textContent = 'online';
  els.status.className = 'status status--on';
});
socket.on('ready', (d) => (state.socketId = d.id));
socket.on('disconnect', () => {
  els.status.textContent = 'offline';
  els.status.className = 'status status--off';
});
socket.on('slice:start', (d) => log(d.message || 'Slicing…'));
socket.on('slice:log', (d) => log(String(d.text).trimEnd(), d.stream === 'stderr' ? 'err' : ''));
socket.on('slice:error', (d) => log(`❌ ${d.message}`, 'err'));
socket.on('slice:done', (d) => log(`✅ ${d.gcode} ready`, 'ok'));
socket.on('print:start', (d) => log(`⤴ Sending to ${d.host}…`));
socket.on('print:log', (d) => log(String(d.text).trimEnd()));
socket.on('print:uploaded', (d) => log(`✅ Uploaded ${d.fileName}`, 'ok'));
socket.on('print:done', (d) => log(d.started ? '🖨️ Print started!' : '✅ On the printer.', 'ok'));
socket.on('print:error', (d) => log(`❌ ${d.message}`, 'err'));
socket.on('print:status', (s) => logStatus(s));

// Format a printer status digest into the log (the key tell is filament detected).
function logStatus(s) {
  if (!s || s.reachable === false) {
    log(`📊 Status unavailable${s && s.error ? ': ' + s.error : ''}`, 'err');
    return;
  }
  log(`📊 Printer status:`);
  log(`   nozzle ${s.nozzle?.temp ?? '?'}→${s.nozzle?.target ?? '?'}°C · bed ${s.bed?.temp ?? '?'}→${s.bed?.target ?? '?'}°C`);
  log(`   filament at nozzle: ${s.filamentDetected ? 'YES ✅' : 'NO ❌ (Canvas not feeding)'}`, s.filamentDetected ? 'ok' : 'err');
  log(`   active tray: ${s.activeTray ?? 'none'} · print state: ${s.printStatus ?? '?'}${s.printError ? ' · error ' + s.printError : ''}`);
}

// ─── Viewport size toggle ────────────────────────────────────
// The handle enlarges/shrinks the 3D viewport (the options panel resizes to
// fill the rest), so you can inspect the model then drop back to the controls.
// Both the Slicer and Paint panels have one.
for (const h of document.querySelectorAll('.panel__handle')) {
  h.addEventListener('click', () => {
    document.body.classList.toggle('tall-view');
    onResize();
  });
}

// ─── Resize ──────────────────────────────────────────────────
// Size the renderer to the CANVAS (which CSS sizes to the top region), not the
// whole window — otherwise the viewport would fill the screen behind the panel.
function onResize() {
  const w = els.canvas.clientWidth || window.innerWidth;
  const h = els.canvas.clientHeight || window.innerHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false); // false: don't let three override the CSS size
  if (!userOrbited) frameView(); // keep the bed framed until the user takes over
}
window.addEventListener('resize', onResize);

// ─── 60 FPS render loop ──────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ─── Boot ────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.bed) state.bed = cfg.bed;
      if (cfg.slicer && !cfg.slicer.available) {
        log('⚠ Slicer not found on the PC — arranging works, slicing is disabled.', 'err');
      }
    }
  } catch {
    /* backend not reachable yet; fall back to defaults */
  }

  // Configure sliders to match the bed.
  els.posX.max = state.bed.x;
  els.posY.max = state.bed.y;
  els.posX.value = state.bed.x / 2;
  els.posY.value = state.bed.y / 2;

  buildBed();
  applyTransform();
  onResize(); // size the renderer to the canvas's top-region height
  requestAnimationFrame(onResize); // re-fit once layout settles
  animate();

  // Load presets + printers, then align the slicing presets to the selected
  // printer (so a CC2 target slices with the CC2 machine preset / Canvas macro).
  Promise.all([loadPresets(), loadPrinters()]).then(autoSelectPresetsForPrinter);
  loadProfiles();
}

init();

// ─── Service worker (PWA offline cache) ──────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
