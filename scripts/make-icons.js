// Draws the extension icons (a downward arrow into a tray on a rounded square) straight into
// RGBA and writes PNGs. No dependencies. Run: bun scripts/make-icons.js
// Shapes mirror icons/icon.svg on a 128 unit grid.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIZES = [16, 32, 48, 128];
// Chrome Web Store: the 128px icon is 96px of art with 16px of transparent padding per side.
// Toolbar sizes stay full bleed so they read at 16px.
const INSET = { 128: 16 };
const SAMPLES = 4; // SAMPLES x SAMPLES sub-pixels per pixel for smooth edges
const BACKGROUND = [30, 58, 95];
const FOREGROUND = [255, 255, 255];

const rect = (x, y, w, h) => (px, py) => px >= x && px < x + w && py >= y && py < y + h;

function roundedRect(x, y, w, h, r) {
  return (px, py) => {
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    return px >= x && px <= x + w && py >= y && py <= y + h && (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };
}

function triangle([ax, ay], [bx, by], [cx, cy]) {
  const side = (px, py, x1, y1, x2, y2) => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  return (px, py) => {
    const d1 = side(px, py, ax, ay, bx, by);
    const d2 = side(px, py, bx, by, cx, cy);
    const d3 = side(px, py, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
}

const background = roundedRect(5, 5, 118, 118, 28);
const foreground = [
  rect(56, 23, 16, 38),
  triangle([38, 59], [90, 59], [64, 87]),
  rect(31, 72, 10, 30),
  rect(87, 72, 10, 30),
  rect(31, 92, 66, 10),
];

// Average the sub-pixel samples of one pixel into [r, g, b, a].
function pixel(col, row, size) {
  const inset = INSET[size] ?? 0;
  const scale = 128 / (size - 2 * inset);
  let r = 0, g = 0, b = 0, hits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = (col - inset + (sx + 0.5) / SAMPLES) * scale;
      const y = (row - inset + (sy + 0.5) / SAMPLES) * scale;
      if (!background(x, y)) continue;
      const [cr, cg, cb] = foreground.some((shape) => shape(x, y)) ? FOREGROUND : BACKGROUND;
      r += cr; g += cg; b += cb; hits++;
    }
  }
  if (hits === 0) return [0, 0, 0, 0];
  return [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((hits / SAMPLES ** 2) * 255)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

function encodePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1)); // each row starts with filter byte 0
  for (let row = 0; row < size; row++) {
    const offset = row * (size * 4 + 1);
    for (let col = 0; col < size; col++) {
      Buffer.from(pixel(col, row, size)).copy(raw, offset + 1 + col * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(import.meta.dir, '..', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) writeFileSync(join(outDir, `icon${size}.png`), encodePng(size));
