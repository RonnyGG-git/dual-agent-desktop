// Genera resources/icon.png (512x512) sin dependencias: PNG escrito a mano con zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4);
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v) => Math.max(0, Math.min(1, v));

function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r, qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const orange = [217, 119, 87], blue = [90, 169, 230], coal = [27, 28, 32];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x - S / 2 + 0.5, cy = y - S / 2 + 0.5;
    let a = clamp(0.5 - sdRoundRect(cx, cy, 236, 92));
    let c = coal.map((v, i) => v + (cy < 0 ? 6 : 0) * (1 - (cy + 256) / 256));
    // dos "nodos" (agentes) unidos por un enlace
    const d1 = Math.hypot(cx + 78, cy + 34) - 82;
    const d2 = Math.hypot(cx - 78, cy - 34) - 82;
    const link = Math.abs((cx * 34 - cy * 78) / Math.hypot(34, 78)) - 10;
    const onLink = link < 0 && Math.abs(cx) < 78;
    const glow1 = clamp(1 - (d1 + 30) / 60) * 0.25, glow2 = clamp(1 - (d2 + 30) / 60) * 0.25;
    c = c.map((v, i) => mix(v, orange[i], glow1));
    c = c.map((v, i) => mix(v, blue[i], glow2));
    if (onLink) c = c.map((v, i) => mix(v, 220, clamp(0.5 - link) * 0.55));
    c = c.map((v, i) => mix(v, blue[i], clamp(0.5 - d2)));
    c = c.map((v, i) => mix(v, orange[i], clamp(0.5 - d1)));
    // núcleo oscuro dentro de cada nodo
    const k1 = Math.hypot(cx + 78, cy + 34) - 30, k2 = Math.hypot(cx - 78, cy - 34) - 30;
    c = c.map((v, i) => mix(v, coal[i], clamp(0.5 - k1) * 0.85));
    c = c.map((v, i) => mix(v, coal[i], clamp(0.5 - k2) * 0.85));
    const o = (y * S + x) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(a * 255);
  }
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname, '..', 'resources'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'icon.png'), png);
console.log('resources/icon.png', png.length, 'bytes');
