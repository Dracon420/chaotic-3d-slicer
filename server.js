/**
 * Elegoo Slicer Phone App — Backend
 * ---------------------------------
 * Express + Socket.io server that:
 *   1. Accepts STL uploads from the phone (multer -> /uploads).
 *   2. Serves the built PWA (client/dist) plus the uploaded models.
 *   3. Drives your local Elegoo/Orca/Prusa slicer over its CLI
 *      (child_process) to turn a model + transform into G-code.
 *   4. Streams live slicer logs back to the phone over Socket.io.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const { transformSTL } = require('./lib/stl');
const { buildThreeMF } = require('./lib/threemf');
const { slice } = require('./lib/slicer');
const { injectThumbnails } = require('./lib/gcode');
const printer = require('./lib/printer');
const bambu = require('./lib/bambu');
const { createStore } = require('./lib/store');
let ensureTls = null;
try { ({ ensureTls } = require('./lib/tls')); } catch { /* node-forge optional */ }

// Parse the slicer's estimate comments from a gcode file (time / filament /
// layers) so the app can show a slicer-style summary after slicing.
function parseGcodeStats(gcodePath) {
  try {
    const txt = fs.readFileSync(gcodePath, 'utf8');
    // Scan the whole file — the embedded thumbnail (top) and the config dump
    // (bottom) push the estimate comments well past any fixed-size window.
    const m = (re) => (txt.match(re) || [])[1];
    const time = m(/estimated printing time \(normal mode\)\s*=\s*([^\n\r]+)/i);
    const weight = parseFloat(m(/total filament used \[g\]\s*=\s*([\d.]+)/i)) || null;
    const lengthMm = m(/;\s*filament used \[mm\]\s*=\s*([^\n\r]+)/i);
    const perColourG = (m(/;\s*filament used \[g\]\s*=\s*([^\n\r]+)/i) || '')
      .split(',').map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n));
    const layers = parseInt(m(/total layer (?:number|count)\s*[:=]\s*(\d+)/i), 10) || null;
    return {
      time: time ? time.trim() : null,
      weightG: weight,
      lengthM: lengthMm ? +(lengthMm.split(',').reduce((a, s) => a + (parseFloat(s) || 0), 0) / 1000).toFixed(2) : null,
      perColourG,
      layers,
    };
  } catch {
    return null;
  }
}

// ─── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
const HOST = process.env.HOST || '0.0.0.0';
const SLICER_PATH = process.env.SLICER_PATH || '';
const PRESETS = {
  machine: process.env.SLICER_MACHINE_PRESET || '',
  process: process.env.SLICER_PROCESS_PRESET || '',
  filament: process.env.SLICER_FILAMENT_PRESET || '',
};
const BED_SIZE_X = parseFloat(process.env.BED_SIZE_X) || 220;
const BED_SIZE_Y = parseFloat(process.env.BED_SIZE_Y) || 220;
const BED_SIZE_Z = parseFloat(process.env.BED_SIZE_Z) || 250;

// Root of the slicer's config (presets live under <root>/user and <root>/system).
// Derived from the machine preset path (…/<root>/user/default/machine/X.json),
// overridable via SLICER_CONFIG_DIR.
const PRESET_ROOT =
  process.env.SLICER_CONFIG_DIR ||
  (PRESETS.machine
    ? path.resolve(path.dirname(PRESETS.machine), '..', '..', '..')
    : path.join(process.env.APPDATA || '', 'ElegooSlicer'));

const ROOT = __dirname;
// Writable data dir — overridable so the packaged desktop app can point it at a
// user-writable location (the app bundle itself is read-only).
const DATA_DIR = process.env.DATA_DIR || ROOT;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.isAbsolute(process.env.OUTPUT_DIR || '')
  ? process.env.OUTPUT_DIR
  : path.join(DATA_DIR, process.env.OUTPUT_DIR || 'output');
const WORK_DIR = path.join(DATA_DIR, '.work'); // transient slice jobs
const CERT_DIR = process.env.CERT_DIR || path.join(DATA_DIR, 'certs');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist'); // read-only, stays in the bundle

// App-level store: user-added printers (incl. Bambu), hidden printers, profiles.
const store = createStore(path.join(DATA_DIR, 'appstore.json'));

const slicerReady = () => Boolean(SLICER_PATH) && fs.existsSync(SLICER_PATH);
const presetsReady = () =>
  Object.values(PRESETS).every((p) => p && fs.existsSync(p));

// Make sure the working folders exist.
for (const dir of [UPLOAD_DIR, OUTPUT_DIR, WORK_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── App / server / sockets ──────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '12mb' })); // room for base64 preview thumbnails

// Serve uploaded models and generated G-code statically.
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/output', express.static(OUTPUT_DIR));

// ─── Multer: STL uploads ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Keep a readable, collision-free, filesystem-safe name.
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB cap
  fileFilter: (_req, file, cb) => {
    const ok = /\.(stl|obj|3mf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .stl, .obj or .3mf files are allowed'), ok);
  },
});

// ─── API: config (bed size, slicer availability) ─────────────
app.get('/api/config', (_req, res) => {
  res.json({
    bed: { x: BED_SIZE_X, y: BED_SIZE_Y },
    slicer: {
      path: SLICER_PATH,
      available: slicerReady(),
      presetsAvailable: presetsReady(),
      presets: {
        machine: path.basename(PRESETS.machine || ''),
        process: path.basename(PRESETS.process || ''),
        filament: path.basename(PRESETS.filament || ''),
      },
    },
  });
});

// ─── API: list selectable presets ────────────────────────────
// Scans the slicer's user presets + bundled Elegoo presets so the phone can
// offer machine / process / filament dropdowns.
function listPresetFiles(dir, recursive) {
  try {
    return fs
      .readdirSync(dir, { recursive, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => path.join(e.parentPath || dir, e.name));
  } catch {
    return [];
  }
}

function collectPresets(type) {
  const userFiles = listPresetFiles(path.join(PRESET_ROOT, 'user', 'default', type), false);
  const sysFiles = listPresetFiles(path.join(PRESET_ROOT, 'system', 'Elegoo', type), true);
  const seen = new Set();
  const items = [];
  for (const [files, source] of [[userFiles, 'user'], [sysFiles, 'system']]) {
    for (const file of files) {
      const name = path.basename(file, '.json');
      // Skip abstract base presets that aren't user-selectable.
      if (/^fdm_/i.test(name) || /@base$/i.test(name)) continue;
      const key = `${source}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name, path: file, source });
    }
  }
  items.sort((a, b) =>
    a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'user' ? -1 : 1
  );
  return items;
}

app.get('/api/presets', (_req, res) => {
  res.json({
    presets: {
      machine: collectPresets('machine'),
      process: collectPresets('process'),
      filament: collectPresets('filament'),
    },
    current: {
      machine: PRESETS.machine,
      process: PRESETS.process,
      filament: PRESETS.filament,
    },
  });
});

// ─── API: upload an STL ──────────────────────────────────────
app.post('/api/upload', upload.single('model'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({
    name: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    url: `/uploads/${encodeURIComponent(req.file.filename)}`,
  });
});

// Only allow preset files that live inside the slicer config dir.
function safePreset(requested, fallback) {
  if (!requested) return fallback;
  const resolved = path.resolve(requested);
  const inRoot = resolved.toLowerCase().startsWith(PRESET_ROOT.toLowerCase() + path.sep);
  if (!inRoot || !resolved.toLowerCase().endsWith('.json') || !fs.existsSync(resolved)) {
    return fallback;
  }
  return resolved;
}

// ─── API: slice ──────────────────────────────────────────────
// Body: { name, socketId, rotZ, scalePercent, machine?, process?, filament?,
//         bedTemp?, nozzleTemp? }
// Flow: bake scale + Z-rotation into the STL -> run the ElegooSlicer CLI with
// CLI-ready preset copies -> publish the resulting G-code for download.
app.post('/api/slice', async (req, res) => {
  const { name, socketId } = req.body || {};
  const rotX = parseFloat(req.body.rotX) || 0;
  const rotY = parseFloat(req.body.rotY) || 0;
  const rotZ = parseFloat(req.body.rotZ) || 0;
  const scale = (parseFloat(req.body.scalePercent) || 100) / 100;
  const bedTemp = parseFloat(req.body.bedTemp);
  const nozzleTemp = parseFloat(req.body.nozzleTemp);
  // Bed/plate type — only accept enum strings the slicer recognises.
  const ALLOWED_BED_TYPES = ['Cool Plate', 'Textured PEI Plate', 'High Temp Plate', 'Engineering Plate'];
  const bedType = ALLOWED_BED_TYPES.includes(req.body.bedType) ? req.body.bedType : undefined;
  const posX = Number.isFinite(parseFloat(req.body.posX)) ? parseFloat(req.body.posX) : BED_SIZE_X / 2;
  const posY = Number.isFinite(parseFloat(req.body.posY)) ? parseFloat(req.body.posY) : BED_SIZE_Y / 2;
  const canvas = req.body.canvas === true; // CC2 multi-material (4-slot Canvas)
  // Chosen Canvas tray (0-3). On a Canvas print we wrap the mesh in a 3MF that
  // assigns the object to filament index = this tray, so the gcode genuinely
  // prints on T<tray> with filament_used on that index (the CLI can't put a raw
  // STL on a non-zero filament). null/absent = single-filament tool 0.
  const tray = Number.isInteger(req.body.selectedTray) && req.body.selectedTray >= 0 && req.body.selectedTray <= 3
    ? req.body.selectedTray
    : null;
  // Per-triangle paint map (0-based tray index per ORIGINAL mesh triangle; 0 =
  // base). Present only for a multi-colour painted job. Sanitised to 0..3.
  const paintMap = Array.isArray(req.body.paintMap) && req.body.paintMap.length
    ? req.body.paintMap.map((v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0))
    : null;
  const hasPaint = paintMap && paintMap.some((v) => v > 0);

  // Per-request preset selection (falls back to the .env defaults).
  const presets = {
    machine: safePreset(req.body.machine, PRESETS.machine),
    process: safePreset(req.body.process, PRESETS.process),
    filament: safePreset(req.body.filament, PRESETS.filament),
  };

  // Richer per-request print settings (whitelisted -> OrcaSlicer process keys).
  const PROCESS_FORMATTERS = {
    layer_height: (v) => String(parseFloat(v)),
    initial_layer_print_height: (v) => String(parseFloat(v)),
    sparse_infill_density: (v) => `${parseInt(v, 10)}%`,
    sparse_infill_pattern: (v) => String(v),
    wall_loops: (v) => String(parseInt(v, 10)),
    top_shell_layers: (v) => String(parseInt(v, 10)),
    bottom_shell_layers: (v) => String(parseInt(v, 10)),
    enable_support: (v) => (v ? '1' : '0'),
    support_type: (v) => String(v),
    brim_type: (v) => String(v),
    brim_width: (v) => String(parseFloat(v)),
    enable_prime_tower: (v) => (v ? '1' : '0'),
    prime_tower_width: (v) => String(parseFloat(v)),
  };
  const printSettings = {};
  const pin = req.body.printSettings || {};
  for (const [k, fmt] of Object.entries(PROCESS_FORMATTERS)) {
    if (pin[k] !== undefined && pin[k] !== '' && pin[k] !== null) {
      try { printSettings[k] = fmt(pin[k]); } catch { /* skip bad value */ }
    }
  }
  // Painted jobs: OrcaSlicer's "interlocking beam" weaves the two colours
  // together for a couple of layers at every colour boundary — that's the
  // "artifacts in other layers" on a layer change. Default it OFF for a crisp
  // change; turn it ON only when the Interlock effect explicitly asks for it.
  if (hasPaint) printSettings.interlocking_beam = req.body.interlock ? '1' : '0';

  // Push events to the requesting phone (falls back to broadcast).
  const emit = (event, payload) => {
    if (socketId && io.sockets.sockets.get(socketId)) io.to(socketId).emit(event, payload);
    else io.emit(event, payload);
  };
  const log = (stream, text) => emit('slice:log', { stream, text });

  if (!name) return res.status(400).json({ error: 'Missing model name' });

  const inputPath = path.join(UPLOAD_DIR, path.basename(name));
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Uploaded model not found on server' });
  }
  if (!slicerReady()) {
    const msg = 'Slicer executable not found. Set SLICER_PATH in .env and restart.';
    emit('slice:error', { message: msg });
    return res.status(503).json({ error: msg });
  }
  if (!presetsReady()) {
    const msg =
      'Slicer presets missing. Set SLICER_MACHINE_PRESET / SLICER_PROCESS_PRESET / ' +
      'SLICER_FILAMENT_PRESET in .env to your saved ElegooSlicer preset JSON files.';
    emit('slice:error', { message: msg });
    return res.status(503).json({ error: msg });
  }

  const modelBase = path.basename(name).replace(/\.[^.]+$/, '');
  // Custom output name (becomes the job name shown on the printer). Sanitised.
  const customName = (req.body.filename || '')
    .toString()
    .replace(/\.gcode$/i, '')
    .replace(/[^a-zA-Z0-9 ._-]/g, '')
    .trim();
  const base = customName || modelBase;
  const jobDir = path.join(WORK_DIR, `${Date.now()}-${modelBase}`);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // 1) Bake scale + Z-rotation + bed placement into a fresh STL (the CLI
    //    ignores --scale/--rotate and won't center a single part reliably).
    const bakedStl = path.join(jobDir, `${base}.stl`);
    emit('slice:start', { message: `Applying scale ${Math.round(scale * 100)}% / rotation ${rotX}°,${rotY}°,${rotZ}° / pos ${Math.round(posX)},${Math.round(posY)}…` });
    const m = transformSTL(inputPath, bakedStl, {
      scale,
      rotXdeg: rotX,
      rotYdeg: rotY,
      rotZdeg: rotZ,
      posX,
      posY,
      bedX: BED_SIZE_X,
      bedY: BED_SIZE_Y,
    });
    log('stdout', `Placed model: ${m.sizeX.toFixed(1)}×${m.sizeY.toFixed(1)}×${m.sizeZ.toFixed(1)} mm at (${Math.round(posX)}, ${Math.round(posY)}).`);
    if (m.sizeX > BED_SIZE_X || m.sizeY > BED_SIZE_Y) {
      log('stderr', `⚠ Model footprint exceeds the ${BED_SIZE_X}×${BED_SIZE_Y} bed — scale it down.`);
    }

    // 1b) Canvas print on a specific tray: wrap the placed mesh in a real 3MF
    //     project whose object is assigned to filament index = tray (extruder is
    //     1-based). Slicing this 3MF emits a consistent multi-filament gcode
    //     (T<tray> + filament_used on that index), exactly like ElegooSlicer.
    let modelPath = bakedStl;
    if (canvas && hasPaint) {
      // Multi-colour: base = tray 0 (extruder 1); painted faces -> their trays.
      const mfPath = path.join(jobDir, `${base}.3mf`);
      const buf = await buildThreeMF(bakedStl, { extruder: 1, name: base, paintByTriangle: paintMap });
      fs.writeFileSync(mfPath, buf);
      modelPath = mfPath;
      const colours = new Set(paintMap.filter((v) => v > 0)).size;
      log('stdout', `Built painted 3MF: base + ${colours} painted colour(s).`);
    } else if (canvas && tray !== null) {
      const mfPath = path.join(jobDir, `${base}.3mf`);
      const buf = await buildThreeMF(bakedStl, { extruder: tray + 1, name: base });
      fs.writeFileSync(mfPath, buf);
      modelPath = mfPath;
      log('stdout', `Built 3MF project: object on filament slot #${tray + 1} (T${tray}).`);
    }

    // 2) Slice with the verified ElegooSlicer CLI recipe.
    const { gcodePath } = await slice({
      exe: SLICER_PATH,
      presets,
      overrides: {
        bedTemp,
        nozzleTemp,
        bedType,
        processSettings: printSettings,
        canvas, // CC2: declare 4 filament slots
        canvasFilaments: Array.isArray(req.body.canvasFilaments) ? req.body.canvasFilaments : null,
        bed: { x: BED_SIZE_X, y: BED_SIZE_Y, z: BED_SIZE_Z },
      },
      stlPath: modelPath,
      outDir: jobDir,
      onLog: log,
    });

    // 2b) Canvas sanity check: the gcode MUST contain the M6211 load macro, or
    //     the Canvas will feed nothing. Its absence means a non-CC2 machine
    //     preset was used (e.g. the CC1 default) — warn clearly.
    if (canvas) {
      const head = fs.readFileSync(gcodePath, 'utf8').slice(0, 20000);
      if (!/M6211/.test(head)) {
        log('stderr', '⚠ This gcode has NO Canvas load macro (M6211). Pick the Centauri Carbon 2 machine preset in Settings — the CC1 preset can\'t drive the Canvas.');
      } else {
        log('stdout', `Canvas load macro present (${(head.match(/M6211/g) || []).length}× M6211).`);
      }
    }

    // 3) Embed a printer thumbnail (rendered on the phone) so the job shows an icon.
    if (req.body.thumbnails && typeof req.body.thumbnails === 'object') {
      try {
        if (injectThumbnails(gcodePath, req.body.thumbnails)) log('stdout', 'Embedded preview thumbnail.');
      } catch (e) {
        log('stderr', `Thumbnail embed skipped: ${e.message}`);
      }
    }

    // 4) Publish the G-code for download (filename = printer job name).
    const finalName = `${base}.gcode`;
    const finalPath = path.join(OUTPUT_DIR, finalName);
    fs.copyFileSync(gcodePath, finalPath);

    // Slicer-style estimate (time / filament / layers) parsed from the gcode.
    const stats = parseGcodeStats(finalPath);
    const result = { gcode: finalName, url: `/output/${encodeURIComponent(finalName)}`, stats };
    emit('slice:done', result);
    res.json({ success: true, ...result });
  } catch (err) {
    emit('slice:error', { message: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    // Tidy the transient job folder (keep the published G-code in OUTPUT_DIR).
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  }
});

// All known printers: auto-detected from the slicer config (minus any the user
// deleted/hid) + user-added ones (incl. Bambu). One entry per host.
function listAllPrinters() {
  const detected = printer
    .readConfiguredPrinters(PRESET_ROOT)
    .filter((p) => !store.isHidden(p.host));
  const custom = store.customPrinters();
  const merged = [...custom];
  for (const d of detected) if (!merged.some((m) => m.host === d.host)) merged.push(d);
  return merged;
}

// ─── API: list printers (with live online status) ────────────
app.get('/api/printers', async (_req, res) => {
  const printers = listAllPrinters();
  await Promise.all(
    printers.map(async (p) => {
      p.online = p.protocol === 'bambu'
        ? await bambu.online(p.host)
        : await printer.printerOnline(p.host, p.protocol);
    })
  );
  // Never ship the Bambu access code to the browser.
  res.json({ printers: printers.map(({ accessCode, ...rest }) => rest) });
});

// ─── API: add / remove a printer ─────────────────────────────
app.post('/api/printers', (req, res) => {
  const { name, host, protocol, serial, accessCode } = req.body || {};
  if (!host || !protocol) return res.status(400).json({ error: 'Missing host or protocol' });
  if (!/^[\w.:-]+$/.test(host)) return res.status(400).json({ error: 'Invalid host/IP' });
  if (protocol === 'bambu' && (!serial || !accessCode)) {
    return res.status(400).json({ error: 'Bambu printers need the serial number and LAN access code (both on the printer screen).' });
  }
  const entry = {
    name: (name || '').trim() || `Printer @ ${host}`,
    host: host.trim(),
    protocol,
    model: protocol === 'bambu' ? 'Bambu (LAN)' : protocol === 'mqtt' ? 'Centauri Carbon 2' : 'Centauri Carbon',
  };
  if (protocol === 'bambu') { entry.serial = serial.trim(); entry.accessCode = accessCode.trim(); }
  store.addPrinter(entry);
  res.json({ success: true });
});

app.delete('/api/printers/:host', (req, res) => {
  const result = store.removePrinter(req.params.host);
  res.json({ success: true, result }); // 'deleted' (custom) or 'hidden' (detected)
});

// ─── API: scan the LAN for printers (handles changed IPs) ────
app.post('/api/scan', async (req, res) => {
  const socketId = req.body && req.body.socketId;
  const onLog = (text) => {
    if (socketId && io.sockets.sockets.get(socketId)) io.to(socketId).emit('scan:log', { text });
  };
  try {
    const found = await printer.scanNetwork({ onLog });
    // Borrow friendly names from the saved list when MainboardIDs match.
    const saved = printer.readConfiguredPrinters(PRESET_ROOT);
    for (const f of found) {
      const known = saved.find((s) => s.mainboardId && s.mainboardId === f.mainboardId);
      if (known) {
        if (!f.name || f.name.startsWith('Printer @')) f.name = known.name;
        if (!f.model) f.model = known.model;
      }
    }
    res.json({ printers: found });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve a printer by host. Always consult the merged list first so server-
// side secrets (Bambu serial/access code) come from the store, not the client;
// fall back to explicit details from the request (e.g. a fresh scan result).
function resolvePrinter(body) {
  if (!body || !body.host) return null;
  const known = listAllPrinters().find((p) => p.host === body.host);
  if (known) return known;
  if (body.protocol) {
    return { host: body.host, protocol: body.protocol, mainboardId: body.mainboardId || '' };
  }
  return null;
}

// ─── API: read a CC2's Canvas filament slots (method 2005) ───
app.get('/api/printer-filament', async (req, res) => {
  const p = resolvePrinter({ host: req.query.host, protocol: req.query.protocol, mainboardId: req.query.mainboardId });
  if (!p) return res.status(404).json({ error: 'Unknown printer' });
  if (p.protocol !== 'mqtt') return res.json({ supported: false, trays: [] });
  try {
    const trays = await printer.getCanvasFilaments({ host: p.host, mainboardId: p.mainboardId });
    res.json({ supported: true, trays });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── API: read a CC2's live status (diagnostics) ─────────────
app.get('/api/printer-status', async (req, res) => {
  const p = resolvePrinter({ host: req.query.host, protocol: req.query.protocol, mainboardId: req.query.mainboardId });
  if (!p) return res.status(404).json({ error: 'Unknown printer' });
  if (p.protocol !== 'mqtt') return res.json({ supported: false });
  try {
    const status = await printer.getStatus({ host: p.host, mainboardId: p.mainboardId });
    res.json({ supported: true, status });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── API: send a sliced job to a printer over the network ────
// Body: { gcode, host, socketId, start, slotMap? }
app.post('/api/print', async (req, res) => {
  const { gcode, host, socketId, start, slotMap } = req.body || {};

  const emit = (event, payload) => {
    if (socketId && io.sockets.sockets.get(socketId)) io.to(socketId).emit(event, payload);
    else io.emit(event, payload);
  };
  const onLog = (text) => emit('print:log', { text });

  if (!gcode || !host) return res.status(400).json({ error: 'Missing gcode or host' });

  const p = resolvePrinter(req.body);
  if (!p) return res.status(404).json({ error: 'Unknown printer' });

  // Only allow sending files we actually produced (no path traversal).
  const gcodePath = path.join(OUTPUT_DIR, path.basename(gcode));
  if (!gcodePath.startsWith(OUTPUT_DIR) || !fs.existsSync(gcodePath)) {
    return res.status(404).json({ error: 'G-code not found — slice it first' });
  }

  try {
    const fileName = path.basename(gcodePath);
    emit('print:start', { host, fileName });

    if (p.protocol === 'bambu') {
      // Bambu A1 etc. (LAN mode): wrap the gcode in a .gcode.3mf, FTPS it to
      // the SD card, then start it with a project_file command over MQTT-TLS.
      if (!p.serial || !p.accessCode) {
        return res.status(400).json({ error: 'This Bambu printer is missing its serial / access code — re-add it on the Printers page.' });
      }
      onLog('Packing gcode into a .gcode.3mf for the Bambu…');
      const wrapped = await bambu.makeGcode3mf(gcodePath);
      const wrapName = fileName.replace(/\.gcode$/i, '') + '.gcode.3mf';
      const wrapPath = path.join(OUTPUT_DIR, wrapName);
      fs.writeFileSync(wrapPath, wrapped);
      await bambu.uploadFile({ host: p.host, accessCode: p.accessCode, filePath: wrapPath, fileName: wrapName, onLog });
      emit('print:uploaded', { fileName: wrapName });
      if (start) {
        await bambu.startPrint({ host: p.host, serial: p.serial, accessCode: p.accessCode, fileName: wrapName, onLog });
        emit('print:done', { started: true });
        return res.json({ success: true, started: true });
      }
    } else if (p.protocol === 'mqtt') {
      // CC2: upload the gcode as-is. The object is assigned (in the 3MF) to
      // filament index = the chosen tray, so the gcode prints on T<tray>; the
      // full identity slot_map + the 2004 handshake (in startPrintCC2) engage
      // the Canvas exactly as ElegooSlicer does.
      await printer.uploadFileCC2({ host: p.host, filePath: gcodePath, fileName, onLog });
      emit('print:uploaded', { fileName });
      if (start) {
        onLog('Upload complete — starting print…');
        await printer.startPrintCC2({ host: p.host, mainboardId: p.mainboardId, fileName, slotMap, onLog });
        emit('print:done', { started: true });
        // Read back the printer state so we can see if it actually engaged.
        onLog('Reading printer status…');
        try {
          const status = await printer.getStatus({ host: p.host, mainboardId: p.mainboardId, durationMs: 9000 });
          emit('print:status', status);
        } catch {
          /* status read is best-effort */
        }
        return res.json({ success: true, started: true });
      }
    } else {
      // CC1: SDCP chunked upload + WebSocket Cmd 128 start.
      await printer.uploadFile({ host: p.host, filePath: gcodePath, fileName, onLog });
      emit('print:uploaded', { fileName });
      if (start) {
        onLog('Upload complete — starting print…');
        const { ack } = await printer.startPrint({ host: p.host, mainboardId: p.mainboardId, fileName, onLog });
        emit('print:done', { started: true, ack });
        return res.json({ success: true, started: true, ack });
      }
    }

    emit('print:done', { started: false });
    res.json({ success: true, started: false });
  } catch (err) {
    emit('print:error', { message: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

// ─── API: saved settings profiles (add / apply / delete) ─────
app.get('/api/profiles', (_req, res) => {
  res.json({ profiles: store.profiles() });
});
app.get('/api/profiles/:name', (req, res) => {
  const p = store.getProfile(req.params.name);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  res.json({ name: req.params.name, settings: p });
});
app.post('/api/profiles', (req, res) => {
  const { name, settings } = req.body || {};
  const clean = (name || '').trim().slice(0, 60);
  if (!clean || !settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'Need a profile name and settings' });
  }
  store.saveProfile(clean, settings);
  res.json({ success: true, profiles: store.profiles() });
});
app.delete('/api/profiles/:name', (req, res) => {
  store.deleteProfile(req.params.name);
  res.json({ success: true, profiles: store.profiles() });
});

// ─── API: read-only printer connectivity test (Cmd 0) ────────
app.post('/api/printer-test', async (req, res) => {
  const { host, mainboardId } = req.body || {};
  if (!host) return res.status(400).json({ error: 'Missing host' });
  try {
    await printer.testConnection({ host, mainboardId, onLog: () => {} });
    res.json({ success: true, reachable: true });
  } catch (err) {
    res.status(502).json({ success: false, reachable: false, error: err.message });
  }
});

// Download the local CA so a phone can trust the HTTPS site (then install the
// PWA standalone). Served over plain HTTP so the phone can fetch it first.
let _caPem = null;
app.get('/rootCA.crt', (_req, res) => {
  if (!_caPem) return res.status(503).send('HTTPS not initialised on this server.');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="Chaotic3D-CA.crt"');
  res.send(_caPem);
});

// ─── Serve the built PWA (production) ────────────────────────
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback for any non-API route.
  app.get(/^(?!\/(api|uploads|output|rootCA)).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .send(
        '<h1>Backend running ✅</h1><p>The PWA has not been built yet. Run ' +
          '<code>npm run build</code> then refresh — or run the Vite dev ' +
          'server with <code>npm run client:dev</code>.</p>'
      );
  });
}

// ─── Socket.io connection logging ────────────────────────────
io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);
  socket.emit('ready', { id: socket.id });
  socket.on('disconnect', () => console.log('[socket] disconnected:', socket.id));
});

// ─── Helper: find IPv4 addresses (LAN + Tailscale separately) ─
// Tailscale hands out 100.64.0.0/10 (CGNAT). Those reach the PC from ANY
// network on your tailnet — perfect for truly-remote mobile slicing.
function isTailscale(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
function allAddresses() {
  const lan = [];
  const ts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      (isTailscale(net.address) ? ts : lan).push(net.address);
    }
  }
  lan.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
  return { lan, ts };
}

// ─── Go ──────────────────────────────────────────────────────
// Start the trusted-HTTPS listener (enables phone PWA install). Best-effort:
// if cert generation isn't available the HTTP server still runs normally.
function startHttps(ips) {
  if (!ensureTls) { console.log('  (HTTPS off: node-forge not installed)\n'); return; }
  try {
    const tls = ensureTls(CERT_DIR, ips, ['localhost']);
    _caPem = tls.caPem;
    const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
    io.attach(httpsServer); // socket.io must accept wss from the HTTPS origin too
    httpsServer.on('error', (e) => console.log(`  (HTTPS disabled: ${e.message})\n`));
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log('  ── Phone PWA install (no address bar) ──');
      for (const ip of ips) console.log(`  Secure:   https://${ip}:${HTTPS_PORT}`);
      console.log(`  1) On the phone open  http://${ips[0] || 'localhost'}:${PORT}/rootCA.crt  and install the certificate`);
      console.log('  2) Then open the https:// address above → browser menu → Install app\n');
    });
  } catch (e) {
    console.log(`  (HTTPS disabled: ${e.message})\n`);
  }
}

server.listen(PORT, HOST, () => {
  const { lan, ts } = allAddresses();
  console.log('\n  Chaotic 3D Slicer — backend is live\n');
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  Network:  http://${ip}:${PORT}   <- open this on your phone`);
  if (ts.length) for (const ip of ts) console.log(`  Tailscale:http://${ip}:${PORT}   <- remote (any network on your tailnet)`);
  console.log('');
  startHttps([...lan, ...ts]); // cert covers LAN + Tailscale so HTTPS works on both
  if (!slicerReady()) {
    console.log('  ⚠  SLICER_PATH not found — arranging works, slicing is disabled.');
    console.log(`     Set it in .env (current: "${SLICER_PATH || 'unset'}")\n`);
  } else if (!presetsReady()) {
    console.log('  ⚠  One or more slicer presets are missing — slicing is disabled.');
    for (const [k, v] of Object.entries(PRESETS)) {
      if (!v || !fs.existsSync(v)) console.log(`     SLICER_${k.toUpperCase()}_PRESET not found: "${v || 'unset'}"`);
    }
    console.log('');
  } else {
    console.log('  ✓  Slicer + presets ready — slicing is enabled.\n');
  }
});
