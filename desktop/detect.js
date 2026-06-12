/**
 * Auto-discover the ElegooSlicer (or OrcaSlicer) install + its presets on this
 * PC, so the desktop app can configure itself with zero manual setup. Returns
 * everything the server needs (exe path, preset files, bed size).
 *
 * Pure Node (no Electron) so it can be unit-tested directly.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const env = (k) => process.env[k] || '';

// Candidate install locations for the slicer executable.
function exeCandidates() {
  const pf = env('ProgramFiles') || 'C:\\Program Files';
  const pf86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const local = env('LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
  const names = [
    ['ElegooSlicer', 'elegoo-slicer.exe'],
    ['OrcaSlicer', 'orca-slicer.exe'],
    ['Bambu Studio', 'bambu-studio.exe'], // for Bambu A1 mini etc.
    ['BambuStudio', 'bambu-studio.exe'],
  ];
  const roots = [pf, pf86, path.join(local, 'Programs')];
  const out = [];
  for (const r of roots) for (const [dir, exe] of names) out.push(path.join(r, dir, exe));
  return out;
}

function findExe() {
  for (const c of exeCandidates()) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// The slicer keeps user presets under %APPDATA%/<Slicer>/user/default/<type>.
function findPresetRoot() {
  const appdata = env('APPDATA') || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const slicer of ['ElegooSlicer', 'OrcaSlicer', 'BambuStudio']) {
    const root = path.join(appdata, slicer);
    if (fs.existsSync(path.join(root, 'user', 'default', 'machine'))) return root;
  }
  return null;
}

function listPresets(root, type) {
  const dir = path.join(root, 'user', 'default', type);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Prefer a Centauri Carbon 2 preset, then any Centauri Carbon, then the first.
function pickMachine(files) {
  const by = (re) => files.find((f) => re.test(path.basename(f)));
  return by(/carbon 2|cc2/i) || by(/centauri carbon/i) || files[0] || '';
}
function pickProcessFor(files, machineName) {
  const cc2 = /carbon 2|cc2/i.test(machineName);
  const by = (re, not) => files.find((f) => re.test(path.basename(f)) && (!not || !not.test(path.basename(f))));
  if (cc2) return by(/cc2/i) || files[0] || '';
  return by(/@elegoo cc |cc /i, /cc2/i) || files[0] || '';
}
function pickFilamentFor(files, machineName) {
  const cc2 = /carbon 2|cc2/i.test(machineName);
  const by = (re, not) => files.find((f) => re.test(path.basename(f)) && (!not || !not.test(path.basename(f))));
  if (cc2) return by(/ecc2|cc2/i) || files.find((f) => /pla|petg/i.test(path.basename(f))) || files[0] || '';
  return by(/ecc(?!2)/i, /ecc2/i) || files.find((f) => /pla|petg/i.test(path.basename(f))) || files[0] || '';
}

// Best-effort bed size from the chosen machine preset (printable_area/height).
function bedFromMachine(machineFile) {
  const def = { x: 256, y: 256, z: 256 };
  try {
    const j = JSON.parse(fs.readFileSync(machineFile, 'utf8'));
    const area = j.printable_area;
    if (Array.isArray(area) && area.length >= 3) {
      const xs = area.map((p) => parseFloat(String(p).split('x')[0]));
      const ys = area.map((p) => parseFloat(String(p).split('x')[1]));
      const x = Math.round(Math.max(...xs)), y = Math.round(Math.max(...ys));
      if (x > 0 && y > 0) def.x = x, def.y = y;
    }
    if (j.printable_height) def.z = Math.round(parseFloat(j.printable_height)) || def.z;
  } catch { /* keep defaults */ }
  return def;
}

/** Run full auto-detection. Returns { ok, exe, presetRoot, machine, process, filament, bed, reason }. */
function detect() {
  const exe = findExe();
  const presetRoot = findPresetRoot();
  if (!exe) return { ok: false, reason: 'ElegooSlicer/OrcaSlicer not found on this PC.' };
  if (!presetRoot) return { ok: false, exe, reason: 'Slicer found, but no saved presets — open the slicer once to create them.' };
  const machines = listPresets(presetRoot, 'machine');
  const processes = listPresets(presetRoot, 'process');
  const filaments = listPresets(presetRoot, 'filament');
  const machine = pickMachine(machines);
  const result = {
    ok: !!(machine && processes.length && filaments.length),
    exe,
    presetRoot,
    machine,
    process: pickProcessFor(processes, path.basename(machine)),
    filament: pickFilamentFor(filaments, path.basename(machine)),
    counts: { machines: machines.length, processes: processes.length, filaments: filaments.length },
  };
  result.bed = bedFromMachine(machine);
  if (!result.ok) result.reason = 'Slicer presets incomplete (need at least one machine, process and filament).';
  return result;
}

// Apply detection into process.env so server.js picks it up (dotenv won't
// override already-set vars). Only fills blanks — respects an existing .env.
function applyToEnv(d) {
  const set = (k, v) => { if (v && !process.env[k]) process.env[k] = String(v); };
  set('SLICER_PATH', d.exe);
  set('SLICER_MACHINE_PRESET', d.machine);
  set('SLICER_PROCESS_PRESET', d.process);
  set('SLICER_FILAMENT_PRESET', d.filament);
  if (d.bed) { set('BED_SIZE_X', d.bed.x); set('BED_SIZE_Y', d.bed.y); set('BED_SIZE_Z', d.bed.z); }
}

module.exports = { detect, applyToEnv, findExe, findPresetRoot };

// CLI: `node desktop/detect.js` prints what it found.
if (require.main === module) {
  console.log(JSON.stringify(detect(), null, 2));
}
