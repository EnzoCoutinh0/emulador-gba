// uso: node run.js rom.gba [frames] [--png saida.png]
const fs = require('fs'), zlib = require('zlib');
const { GBA } = require('../core.js');
const args = process.argv.slice(2);
const rom = new Uint8Array(fs.readFileSync(args[0]));
const frames = parseInt(args[1] || '60');
const g = new GBA();
g.log = (m) => console.log('[log]', m);
g.loadRom(rom);
const t0 = Date.now();
let f = 0;
for (; f < frames; f++) {
  g.runFrame();
  if (g.bus.ewram32[15] === 0xDEADBEEF && !args.includes('--png')) break;
}
const ms = Date.now() - t0;
console.log(`frames=${f} tempo=${ms}ms (${(f / (ms / 1000)).toFixed(1)} fps) pc=${g.cpu.r[15].toString(16)} T=${g.cpu.T}`);
const out = []; for (let i = 0; i < 8; i++) out.push(g.bus.ewram32[i].toString(16).padStart(8, '0'));
console.log('ewram:', out.join(' '), g.bus.ewram32[15] === 0xDEADBEEF ? 'FIM' : 'NÃO TERMINOU');
const pi = args.indexOf('--png');
if (pi >= 0) {
  const w = 240, h = 160, px = new Uint8Array(g.ppu.frameBuf);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const crc = (buf) => { let c, crcT = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; } let x = 0xFFFFFFFF; for (const b of buf) x = crcT[(x ^ b) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(args[pi + 1], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('png:', args[pi + 1]);
}
module.exports = g;
