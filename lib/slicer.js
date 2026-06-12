/**
 * Drives the ElegooSlicer / OrcaSlicer command line.
 *
 * The tricky part: ElegooSlicer is an OrcaSlicer fork, and the presets you save
 * in its GUI are *overlay* presets — they only store what differs from a parent
 * and omit fields the CLI demands. Loading them directly fails. This module
 * rewrites them into CLI-ready copies. The exact fixes below were each found by
 * running the real slicer and reading its errors:
 *
 *   1. inject  "type": machine|process|filament   (CLI: "unknown config type")
 *   2. write   compatible_printers explicitly      (CLI: "process not compatible")
 *   3. ensure  before_layer_change_gcode has G92 E0 (CLI: relative-E validation)
 *
 * Then it slices with:
 *   <exe> --load-settings "machine.json;process.json" \
 *         --load-filaments "filament.json" \
 *         --slice 0 --orient 0 --arrange 1 --outputdir <dir> <model.stl>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── Inheritance resolution ───────────────────────────────────
// The ElegooSlicer CLI does NOT reliably resolve a user preset's `inherits`
// chain (machine_start_gcode, printable_area, before_layer_change_gcode, … all
// silently fall back to defaults — which is why e.g. the Canvas load macro went
// missing). So we flatten the whole chain ourselves and hand the CLI a complete
// preset. Parent presets are found by name under user/default/<type> and the
// bundled system presets.
const _indexCache = {};
function presetIndex(root, type) {
  const key = `${root}|${type}`;
  if (_indexCache[key]) return _indexCache[key];
  const idx = {};
  const seg = `${path.sep}${type}${path.sep}`;
  for (const base of [path.join(root, 'user', 'default', type), path.join(root, 'system')]) {
    let entries;
    try {
      entries = fs.readdirSync(base, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const full = path.join(e.parentPath || base, e.name);
      if (base.includes(`${path.sep}system`) && !full.includes(seg)) continue; // scope system to this type
      const name = e.name.replace(/\.json$/, '');
      if (!(name in idx)) idx[name] = full;
    }
  }
  _indexCache[key] = idx;
  return idx;
}

function resolveInheritance(presetPath, type, root, seen = new Set()) {
  const json = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  const inh = json.inherits;
  delete json.inherits;
  if (!inh) return json;
  const idx = presetIndex(root, type);
  let merged = {};
  for (const pname of Array.isArray(inh) ? inh : [inh]) {
    if (!pname || seen.has(pname) || !idx[pname]) continue;
    seen.add(pname);
    merged = { ...merged, ...resolveInheritance(idx[pname], type, root, seen) };
  }
  return { ...merged, ...json }; // child overrides parent
}

// Config root = <root>/user/default/<type>/<file>.json  ->  <root>
function configRootOf(presetPath) {
  return path.resolve(path.dirname(presetPath), '..', '..', '..');
}

function writeReadyPreset(srcPath, type, extra, destDir) {
  const orig = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const json = resolveInheritance(srcPath, type, configRootOf(srcPath));
  json.type = type;
  // Keep the original `inherits` so the CLI's compatibility check can still
  // derive the printer's base name — but every field is now also inline.
  if (orig.inherits) json.inherits = orig.inherits;
  Object.assign(json, extra);
  for (const k of Object.keys(extra)) if (extra[k] === null) delete json[k]; // null = remove key
  const dest = path.join(destDir, `${type}.json`);
  fs.writeFileSync(dest, JSON.stringify(json, null, 2));
  return dest;
}

const PLATE_TEMP_KEYS = [
  'cool_plate_temp',
  'hot_plate_temp',
  'eng_plate_temp',
  'textured_plate_temp',
  'supertack_plate_temp',
];

/**
 * Turn an optional { bedTemp, nozzleTemp } override into the filament-preset
 * fields ElegooSlicer expects. Bed temp is set for every plate type (so it
 * applies whichever bed is selected); nozzle temp covers both layers. Values
 * are arrays because filament settings are per-extruder.
 */
function filamentTempOverrides({ bedTemp, nozzleTemp } = {}) {
  const extra = {};
  if (Number.isFinite(bedTemp) && bedTemp > 0) {
    for (const k of PLATE_TEMP_KEYS) {
      extra[k] = [String(bedTemp)];
      extra[`${k}_initial_layer`] = [String(bedTemp)];
    }
  }
  if (Number.isFinite(nozzleTemp) && nozzleTemp > 0) {
    extra.nozzle_temperature = [String(nozzleTemp)];
    extra.nozzle_temperature_initial_layer = [String(nozzleTemp)];
  }
  return extra;
}

/** Build CLI-loadable copies of the three GUI presets. */
function prepareCliPresets({ machine, process: proc, filament }, destDir, overrides = {}) {
  fs.mkdirSync(destDir, { recursive: true });

  const machineJson = JSON.parse(fs.readFileSync(machine, 'utf8'));
  // The process's compatibility check matches against these printer names.
  const printerNames = [...new Set([machineJson.name, machineJson.inherits].filter(Boolean))];

  const machineExtra = {};
  if (!machineJson.before_layer_change_gcode) {
    machineExtra.before_layer_change_gcode = ';BEFORE_LAYER_CHANGE\n;[layer_z]\nG92 E0\n';
  }
  // The bed size doesn't resolve through the CLI either — without this the
  // slicer defaults to a 200x200x100 plate, offsetting prints and capping height.
  const bed = overrides.bed;
  if (bed && bed.x && bed.y) {
    machineExtra.printable_area = ['0x0', `${bed.x}x0`, `${bed.x}x${bed.y}`, `0x${bed.y}`];
    if (bed.z) machineExtra.printable_height = String(bed.z);
  }

  const filamentExtra = {
    compatible_printers: printerNames,
    compatible_printers_condition: null, // drop inherited condition; match by the list above
    ...filamentTempOverrides(overrides),
  };

  // Bed type selects which per-plate temp the filament uses (Cool/Textured/Smooth).
  const processExtra = {
    compatible_printers: printerNames,
    compatible_printers_condition: null, // drop inherited condition; match by the list above
  };
  if (overrides.bedType) processExtra.curr_bed_type = overrides.bedType;
  // Richer print settings (layer height, infill, walls, supports, brim, …).
  if (overrides.processSettings && typeof overrides.processSettings === 'object') {
    Object.assign(processExtra, overrides.processSettings);
  }

  return {
    machine: writeReadyPreset(machine, 'machine', machineExtra, destDir),
    process: writeReadyPreset(proc, 'process', processExtra, destDir),
    filament: writeReadyPreset(filament, 'filament', filamentExtra, destDir),
  };
}

/**
 * Slice `stlPath` into `outDir`. Streams stdout/stderr line-by-line to onLog.
 * Resolves with { gcodePath } or rejects with an Error (message = best log line).
 */
function slice({ exe, presets, overrides = {}, stlPath, outDir, onLog = () => {} }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const ready = prepareCliPresets(presets, path.join(outDir, '_presets'), overrides);

    // For a Canvas (multi-material) printer, declare 4 filament slots so the
    // gcode carries the AMS structure. Each slot is a copy of the chosen
    // filament preset, tagged with that tray's colour (so the printer's file
    // list shows the right colour_map). The object's tray assignment lives in
    // the 3MF (object extruder index); the identity slot_map routes it.
    let filamentArg;
    if (overrides.canvas) {
      const cols = Array.isArray(overrides.canvasFilaments) ? overrides.canvasFilaments : [];
      const base = JSON.parse(fs.readFileSync(ready.filament, 'utf8'));
      const DEFAULT_COLOURS = ['#000000', '#2850DF', '#7C4C00', '#FFF242'];
      const paths = [];
      for (let i = 0; i < 4; i++) {
        const j = { ...base };
        // Always set a VALID 6-hex colour on every slot — the slicer rejects the
        // job if filament_colour's count doesn't match the 4 filaments.
        const c = cols[i] && cols[i].colour;
        const valid = typeof c === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c);
        j.filament_colour = [valid ? (c.startsWith('#') ? c : `#${c}`) : DEFAULT_COLOURS[i]];
        const p = path.join(outDir, '_presets', `filament_${i}.json`);
        fs.writeFileSync(p, JSON.stringify(j, null, 2));
        paths.push(p);
      }
      filamentArg = paths.join(';');
    } else {
      filamentArg = ready.filament;
    }

    const args = [
      '--load-settings', `${ready.machine};${ready.process}`,
      '--load-filaments', filamentArg,
      '--slice', '0',
      '--orient', '0',
      '--arrange', '0', // we bake exact placement into the STL ourselves
      '--outputdir', outDir,
      stlPath,
    ];

    onLog('stdout', `${exe} ${args.join(' ')}`);
    const child = spawn(exe, args, { windowsHide: true });

    let lastError = '';
    const wire = (stream) => (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/\[error\]|error|not compatible|exit/i.test(line)) lastError = line;
        onLog(stream, line);
      }
    };
    child.stdout.on('data', wire('stdout'));
    child.stderr.on('data', wire('stderr'));

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      // ElegooSlicer writes plate_1.gcode (etc.) into outDir.
      let gcode = null;
      try {
        gcode = fs
          .readdirSync(outDir)
          .filter((f) => f.toLowerCase().endsWith('.gcode'))
          .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0]?.f;
      } catch {
        /* ignore */
      }
      if (code === 0 && gcode) {
        resolve({ gcodePath: path.join(outDir, gcode) });
      } else {
        reject(new Error(lastError || `Slicer exited with code ${code}`));
      }
    });
  });
}

module.exports = { slice, prepareCliPresets };
