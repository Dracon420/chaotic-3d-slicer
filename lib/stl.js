/**
 * Minimal STL reader/writer used to BAKE the phone's scale + Z-rotation into
 * the mesh before slicing. ElegooSlicer's CLI ignores --scale/--rotate, so we
 * apply the transform here and hand the slicer a ready-to-go model.
 *
 * Handles both binary and ASCII STL input; always writes compact binary STL.
 */
const fs = require('fs');

function parseBinary(buf, n) {
  const tris = [];
  let off = 84;
  for (let i = 0; i < n; i++) {
    let p = off + 12; // skip the stored normal
    const v = [];
    for (let j = 0; j < 3; j++) {
      v.push([buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]);
      p += 12;
    }
    tris.push(v);
    off += 50;
  }
  return tris;
}

function parseASCII(text) {
  const tris = [];
  const verts = [];
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text))) {
    verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (verts.length === 3) tris.push(verts.splice(0, 3));
  }
  return tris;
}

function parseSTL(buf) {
  // Binary STL: 80-byte header + uint32 count + 50 bytes/triangle.
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length === 84 + n * 50) return parseBinary(buf, n);
  }
  const text = buf.toString('utf8');
  if (/^\s*solid/i.test(text) && /facet/i.test(text)) {
    const tris = parseASCII(text);
    if (tris.length) return tris;
  }
  // Last resort: trust the binary header even if the size has trailing bytes.
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length >= 84 + n * 50) return parseBinary(buf, n);
  }
  throw new Error('Unrecognized STL format');
}

/**
 * Read an STL, apply uniform `scale` and a Z-axis rotation, then PLACE it on
 * the bed: its XY footprint center goes to (posX, posY) in printer bed
 * coordinates (origin at the front-left corner) and its base rests at Z=0.
 * This is what actually positions the print — we no longer rely on the
 * slicer's auto-arrange (which dropped single parts toward a corner). Writes a
 * binary STL to `destPath`. Returns { triangles, sizeX, sizeY, sizeZ }.
 */
function transformSTL(
  srcPath,
  destPath,
  { scale = 1, rotXdeg = 0, rotYdeg = 0, rotZdeg = 0, posX, posY, bedX = 220, bedY = 220 } = {}
) {
  const tris = parseSTL(fs.readFileSync(srcPath));
  const d2r = Math.PI / 180;
  const ax = rotXdeg * d2r, ay = rotYdeg * d2r, az = rotZdeg * d2r;
  const cx0 = Math.cos(ax), sx0 = Math.sin(ax);
  const cy0 = Math.cos(ay), sy0 = Math.sin(ay);
  const cz0 = Math.cos(az), sz0 = Math.sin(az);
  // Apply rotX, then rotY, then rotZ (same order as Three's rotateX/Y/Z), then scale.
  const rot = ([x, y, z]) => {
    // rotX
    let y1 = y * cx0 - z * sx0;
    let z1 = y * sx0 + z * cx0;
    let x1 = x;
    // rotY
    let x2 = x1 * cy0 + z1 * sy0;
    let z2 = -x1 * sy0 + z1 * cy0;
    let y2 = y1;
    // rotZ
    let x3 = x2 * cz0 - y2 * sz0;
    let y3 = x2 * sz0 + y2 * cz0;
    let z3 = z2;
    return [scale * x3, scale * y3, scale * z3];
  };

  // Pass 1: scale + rotate every vertex, tracking the bounding box.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const rotated = tris.map((tri) =>
    tri.map((vtx) => {
      const r = rot(vtx);
      if (r[0] < minX) minX = r[0];
      if (r[0] > maxX) maxX = r[0];
      if (r[1] < minY) minY = r[1];
      if (r[1] > maxY) maxY = r[1];
      if (r[2] < minZ) minZ = r[2];
      if (r[2] > maxZ) maxZ = r[2];
      return r;
    })
  );

  // Translation: footprint center -> (posX, posY); base -> Z=0.
  const targetX = Number.isFinite(posX) ? posX : bedX / 2;
  const targetY = Number.isFinite(posY) ? posY : bedY / 2;
  const dx = targetX - (minX + maxX) / 2;
  const dy = targetY - (minY + maxY) / 2;
  const dz = -minZ;

  const out = Buffer.alloc(84 + tris.length * 50);
  out.write('Baked by Elegoo Slice Phone App', 0, 'ascii');
  out.writeUInt32LE(tris.length, 80);

  let off = 84;
  for (const tri of rotated) {
    const place = (v) => [v[0] + dx, v[1] + dy, v[2] + dz];
    const a = place(tri[0]);
    const b = place(tri[1]);
    const c = place(tri[2]);

    // Recompute the facet normal from the final vertices.
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * v[2] - u[2] * v[1];
    let ny = u[2] * v[0] - u[0] * v[2];
    let nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    out.writeFloatLE(nx, off);
    out.writeFloatLE(ny, off + 4);
    out.writeFloatLE(nz, off + 8);
    let p = off + 12;
    for (const vert of [a, b, c]) {
      out.writeFloatLE(vert[0], p);
      out.writeFloatLE(vert[1], p + 4);
      out.writeFloatLE(vert[2], p + 8);
      p += 12;
    }
    out.writeUInt16LE(0, off + 48); // attribute byte count
    off += 50;
  }

  fs.writeFileSync(destPath, out);
  return {
    triangles: tris.length,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

module.exports = { transformSTL, parseSTL };
