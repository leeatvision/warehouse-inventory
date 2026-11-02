// Draws the plain placeholder icons in brand-default/ (a white box on blue). Plain Node, no packages.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, draw) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b] = draw(x / size, y / size); const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BLUE = [37, 99, 235], WHITE = [255, 255, 255];
// A simple box: outline plus a lid line, centred, inside the maskable safe zone.
const draw = (x, y) => {
  const inBox = x > 0.3 && x < 0.7 && y > 0.32 && y < 0.7;
  const inner = x > 0.345 && x < 0.655 && y > 0.365 && y < 0.655;
  const lid = y > 0.44 && y < 0.475 && x > 0.3 && x < 0.7;
  const tab = x > 0.47 && x < 0.53 && y > 0.44 && y < 0.53;
  return (inBox && !inner) || lid || tab ? WHITE : BLUE;
};
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL('../brand-default/' + name, import.meta.url), png(size, draw));
}
console.log('Wrote placeholder icons to brand-default/');
