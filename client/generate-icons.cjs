/**
 * Generates the PWA app icons (no image libraries needed — encodes PNGs by
 * hand with Node's built-in zlib). Run:  node generate-icons.js
 * Output: public/icons/icon-192.png, icon-512.png, icon-maskable-512.png
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ── CRC32 (PNG chunks) ──────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ── Draw one icon into an RGBA buffer ───────────────────────
function draw(size, { maskable }) {
  const bg = [13, 17, 23];
  const bed = [47, 129, 247];
  const layer = [150, 196, 255];
  const px = Buffer.alloc(size * size * 4);

  const margin = Math.round(size * (maskable ? 0.26 : 0.17));
  const lo = margin;
  const hi = size - margin;
  const r = Math.round((hi - lo) * 0.16);
  const stripe = Math.max(4, Math.round(size * 0.085));
  const line = Math.max(2, Math.round(size * 0.022));

  const inRoundRect = (x, y) => {
    if (x < lo || x >= hi || y < lo || y >= hi) return false;
    const corners = [
      [lo + r, lo + r, x < lo + r && y < lo + r],
      [hi - r, lo + r, x >= hi - r && y < lo + r],
      [lo + r, hi - r, x < lo + r && y >= hi - r],
      [hi - r, hi - r, x >= hi - r && y >= hi - r],
    ];
    for (const [cx, cy, active] of corners) {
      if (active && Math.hypot(x - cx, y - cy) > r) return false;
    }
    return true;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = bg;
      if (inRoundRect(x, y)) {
        const rely = (y - lo) % stripe;
        c = rely < line ? layer : bed;
      }
      const i = (y * size + x) * 4;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = 255;
    }
  }
  return px;
}

// ── Encode RGBA buffer -> PNG ───────────────────────────────
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 already 0 (compression, filter, interlace)

  // Add the per-row filter byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, opts] of targets) {
  const png = encodePNG(size, draw(size, opts));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote', path.relative(__dirname, path.join(OUT, name)), `(${png.length} bytes)`);
}
