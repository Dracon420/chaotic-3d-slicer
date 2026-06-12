/**
 * Inject preview thumbnails into a sliced G-code file so the printer shows an
 * icon for the job. Uses the OrcaSlicer/PrusaSlicer thumbnail block format that
 * ElegooSlicer's own G-code uses (the slicer's `thumbnails = 48x48/PNG,...`
 * setting asks for these, but the headless CLI never renders them).
 */
const fs = require('fs');

function thumbnailBlock(thumbs) {
  // Matches ElegooSlicer's exact layout (blank + ';' before each begin).
  let out = '; THUMBNAIL_BLOCK_START\n\n;\n';
  for (const [size, b64] of Object.entries(thumbs)) {
    if (!b64) continue;
    out += `; thumbnail begin ${size} ${b64.length}\n`;
    for (let i = 0; i < b64.length; i += 78) out += `; ${b64.slice(i, i + 78)}\n`;
    out += '; thumbnail end\n';
  }
  out += '; THUMBNAIL_BLOCK_END\n';
  return out;
}

/**
 * thumbs: { "48x48": <base64 png>, "300x300": <base64 png> } (no data: prefix).
 * Inserts the block right after the gcode's HEADER_BLOCK_END (or at the top).
 */
function injectThumbnails(gcodePath, thumbs) {
  const sizes = Object.keys(thumbs || {}).filter((k) => thumbs[k]);
  if (!sizes.length) return false;

  let g = fs.readFileSync(gcodePath, 'utf8');
  if (/^; THUMBNAIL_BLOCK_START/m.test(g)) return false; // already present

  const block = thumbnailBlock(thumbs);
  const marker = g.indexOf('; HEADER_BLOCK_END');
  if (marker >= 0) {
    const insertAt = g.indexOf('\n', marker) + 1;
    g = g.slice(0, insertAt) + block + g.slice(insertAt);
  } else {
    g = block + g;
  }
  fs.writeFileSync(gcodePath, g);
  return true;
}

/**
 * Repoint a single-colour Canvas job to a different filament tool/tray.
 *
 * The ElegooSlicer CLI always emits the object on tool `T0`, but the CC2's
 * Canvas feeds the tray named by the gcode's `T<n>` (not by slot_map alone). So
 * to print from tray N we rewrite the start-sequence tool selects from `T0` to
 * `T<n>` — matching what ElegooSlicer's own gcode does (e.g. `M6211 ... T2` / `T2`).
 * Only valid for single-colour jobs (one tool); the declared filaments are
 * identical so temperatures are unaffected. Returns the rewritten gcode string.
 */
function repointTool(gcode, n) {
  if (!n) return gcode; // already T0
  let changed = 0;
  const out = gcode.split('\n').map((line) => {
    if (/^T0\s*(;.*)?$/.test(line)) { changed++; return line.replace(/^T0/, `T${n}`); }
    if (/^M6211\b/.test(line) && /\bT0\b/.test(line)) { changed++; return line.replace(/\bT0\b/, `T${n}`); }
    return line;
  });
  return { gcode: out.join('\n'), changed };
}

module.exports = { injectThumbnails, repointTool };
