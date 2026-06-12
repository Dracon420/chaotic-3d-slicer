/**
 * 3MF (Orca/Bambu flavour) project generator.
 *
 * Why this exists: the ElegooSlicer CLI ALWAYS assigns a raw STL to filament
 * index 0 (tool T0) — there is no flag to put a bare mesh on a non-zero
 * filament. The per-object filament assignment lives ONLY inside a 3MF project
 * (Metadata/model_settings.config -> <object><metadata key="extruder">). So to
 * make the CC2 Canvas feed a chosen tray we wrap the placed mesh in a real 3MF
 * whose object is assigned to filament index = the tray, then slice THAT. The
 * slicer then emits a genuinely-consistent gcode (T<tray> + filament_used on
 * that index), exactly like ElegooSlicer's own "save project" output — unlike
 * the old text-repoint hack which left the accounting on filament 0.
 *
 * Structure mirrors a real ElegooSlicer .3mf (dissected from ref.3mf):
 *   [Content_Types].xml
 *   _rels/.rels                      -> /3D/3dmodel.model
 *   3D/3dmodel.model                 -> object (inline mesh) + build item
 *   Metadata/model_settings.config   -> object/part extruder + plate filament_maps
 *
 * project_settings.config is intentionally NOT embedded — we slice with
 * --load-settings / --load-filaments so the existing resolved presets drive
 * machine/process/filament config (the 3MF only carries geometry + the
 * object->filament assignment).
 *
 * paintByTriangle (optional) is the future multi-colour hook: an array (one
 * entry per input triangle) of Bambu paint_color codes; entries left null/empty
 * are emitted without a paint_color (they use the object's default extruder).
 */
const fs = require('fs');
const JSZip = require('jszip');
const { parseSTL } = require('./stl');

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// Whole-face paint_color codes by 0-based tray index, decoded from ElegooSlicer's
// ref.3mf and validated by slicing (each painted a whole cube onto that filament
// index). Tray 0 = the object's default extruder (no paint_color attribute).
const PAINT_CODE = { 1: '8', 2: '0C', 3: '1C' };
const paintCodeForTray = (t) => (t > 0 ? PAINT_CODE[t] || null : null);

/**
 * Dedupe a flat triangle-soup ([[v,v,v],...]) into an indexed mesh.
 * Coordinates are quantised to 1e-4 mm so coincident vertices merge.
 */
function indexMesh(tris) {
  const map = new Map();
  const verts = [];
  const faces = [];
  const key = (v) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
  const idx = (v) => {
    const k = key(v);
    let i = map.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push(v);
      map.set(k, i);
    }
    return i;
  };
  const faceSrc = []; // original triangle index for each kept face (paint alignment)
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    const a = idx(t[0]), b = idx(t[1]), c = idx(t[2]);
    if (a === b || b === c || a === c) continue; // drop degenerate faces
    faces.push([a, b, c]);
    faceSrc.push(ti);
  }
  return { verts, faces, faceSrc };
}

function modelXml(verts, faces, paintByTriangle) {
  const vLines = verts.map((v) => `    <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`);
  const tLines = faces.map((f, i) => {
    const pc = paintByTriangle && paintByTriangle[i];
    const paint = pc ? ` paint_color="${pc}"` : '';
    return `    <triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"${paint}/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <metadata name="Application">ElegooSlicerPhoneApp</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
${vLines.join('\n')}
    </vertices>
    <triangles>
${tLines.join('\n')}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>`;
}

/**
 * model_settings.config: assigns object id=1 (and its single part) to filament
 * `extruder` (1-based), and declares the plate's filament_maps. For a painted
 * mesh the per-triangle paint_color in the mesh overrides this default.
 */
function modelSettingsXml(extruder, name) {
  const e = String(extruder);
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <metadata key="name" value="${xmlEsc(name)}"/>
    <metadata key="extruder" value="${e}"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${xmlEsc(name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${xmlEsc(name)}"/>
      <metadata key="extruder" value="${e}"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="1 1 1 1"/>
    <model_instance>
      <metadata key="object_id" value="1"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="1" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0"/>
  </assemble>
</config>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/**
 * Build a 3MF project Buffer from a placed STL on disk.
 * @param {string} stlPath   placed/baked binary STL
 * @param {object} opts
 * @param {number} opts.extruder        1-based filament index to assign the object to
 * @param {string} [opts.name]          object/part display name
 * @param {string[]} [opts.paintByTriangle]  optional per-triangle paint codes (multi-colour)
 * @returns {Promise<Buffer>}
 */
async function buildThreeMF(stlPath, { extruder = 1, name = 'model', paintByTriangle = null } = {}) {
  const tris = parseSTL(fs.readFileSync(stlPath));
  const { verts, faces, faceSrc } = indexMesh(tris);
  // paintByTriangle: per-ORIGINAL-triangle 0-based tray index (0 = base / no
  // paint). Re-key it onto the kept faces (degenerate faces were dropped) and
  // convert each tray index to its validated paint_color code.
  let perFaceCode = null;
  if (Array.isArray(paintByTriangle) && paintByTriangle.length) {
    perFaceCode = faceSrc.map((si) => paintCodeForTray(paintByTriangle[si] | 0));
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('3D').file('3dmodel.model', modelXml(verts, faces, perFaceCode));
  zip.folder('Metadata').file('model_settings.config', modelSettingsXml(extruder, name));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { buildThreeMF, indexMesh };
