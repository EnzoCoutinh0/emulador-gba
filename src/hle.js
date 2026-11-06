'use strict';
// =====================================================================
// hle.js — BIOS EMULADA ("HLE" = emulação de alto nível)
// =====================================================================
// A BIOS do GBA tem funções prontas que os jogos chamam com a instrução
// SWI n. Em vez de rodar o código da BIOS (que é da Nintendo e não pode
// ser distribuído), cada função foi reescrita em JavaScript e dá o mesmo
// resultado. Os parâmetros chegam em r0–r3 e as respostas voltam em r0–r3.
// =====================================================================
// ===================== BIOS emulada (HLE das SWIs) =====================
class HLE {
  constructor(gba) { this.gba = gba; this.unknown = new Set(); }

  // Tabela das funções. As mais usadas pelos jogos:
  //   0x05 VBlankIntrWait — espera o próximo quadro (todo jogo usa)
  //   0x06 Div / 0x08 Sqrt — divisão e raiz quadrada
  //   0x0B/0x0C CpuSet/CpuFastSet — copiar ou preencher memória
  //   0x0E/0x0F — calcular rotação e zoom de fundos e sprites
  //   0x11/0x12 LZ77, 0x13 Huffman, 0x14/0x15 RLE — descomprimir gráficos
  call(n, pc) {
    const g = this.gba, cpu = g.cpu, r = cpu.r, bus = g.bus;
    cpu.extra += 10;
    switch (n) {
      case 0x00: this.softReset(); return;
      case 0x01: this.registerRamReset(r[0]); return;
      case 0x02: case 0x03: cpu.halted = true; return;
      case 0x04: this.intrWait(r[0], r[1], pc); return;
      case 0x05: r[0] = 1; r[1] = 1; this.intrWait(1, 1, pc); return;
      case 0x06: this.div(r[0] | 0, r[1] | 0); return;
      case 0x07: this.div(r[1] | 0, r[0] | 0); return;
      case 0x08: r[0] = Math.floor(Math.sqrt(r[0])); return;
      case 0x09: {
        const t = ((r[0] << 16) >> 16) / 16384;
        r[0] = Math.round(Math.atan(t) / Math.PI * 0x8000) | 0;
        return;
      }
      case 0x0A: {
        const x = (r[0] << 16) >> 16, y = (r[1] << 16) >> 16;
        let a = Math.atan2(y, x); if (a < 0) a += 2 * Math.PI;
        r[0] = Math.round(a / (2 * Math.PI) * 65536) & 0xFFFF;
        return;
      }
      case 0x0B: this.cpuSet(r[0], r[1], r[2], false); return;
      case 0x0C: this.cpuSet(r[0], r[1], r[2], true); return;
      case 0x0D: r[0] = 0xBAAE187F; return;
      case 0x0E: this.bgAffineSet(r[0], r[1], r[2]); return;
      case 0x0F: this.objAffineSet(r[0], r[1], r[2], r[3]); return;
      case 0x10: this.bitUnpack(r[0], r[1], r[2]); return;
      case 0x11: this.lz77(r[0], r[1], false); return;
      case 0x12: this.lz77(r[0], r[1], true); return;
      case 0x13: this.huff(r[0], r[1]); return;
      case 0x14: this.rl(r[0], r[1], false); return;
      case 0x15: this.rl(r[0], r[1], true); return;
      case 0x16: this.diff8(r[0], r[1], false); return;
      case 0x17: this.diff8(r[0], r[1], true); return;
      case 0x18: this.diff16(r[0], r[1]); return;
      case 0x19: return;
      case 0x1F: {
        const freq = bus.read32((r[0] + 4) >>> 0);
        r[0] = (freq / Math.pow(2, (180 - r[1] - r[2] / 256) / 12)) >>> 0;
        return;
      }
      default:
        if (!this.unknown.has(n)) { this.unknown.add(n); if (g.log) g.log('SWI não emulada: 0x' + n.toString(16)); }
        return;
    }
  }

  // Reinicia o jogo (A+B+Start+Select nos Pokémon).
  softReset() {
    const g = this.gba, cpu = g.cpu, bus = g.bus;
    const flag = bus.read8(0x03007FFA);
    for (let a = 0x7E00; a < 0x8000; a++) bus.iwram[a] = 0;
    cpu.reset();
    if (flag) cpu.r[15] = 0x02000000;
    cpu.branched = true;
  }

  // Limpa as memórias e os registradores indicados pelos bits de r0.
  registerRamReset(f) {
    const g = this.gba, bus = g.bus, io = g.io;
    if (f & 1) bus.ewram.fill(0);
    if (f & 2) bus.iwram.fill(0, 0, 0x7E00);
    if (f & 4) bus.pal.fill(0);
    if (f & 8) bus.vram.fill(0);
    if (f & 16) bus.oam.fill(0);
    if (f & 32) { for (let o = 0x120; o < 0x160; o += 2) io.regs[o >> 1] = 0; io.regs[0x134 >> 1] = 0x8000; }
    if (f & 64) { for (let o = 0x60; o < 0xA8; o += 2) io.write16(o, 0); io.write16(0x88, 0x200); }
    if (f & 128) {
      for (let o = 0; o < 0x60; o += 2) io.write16(o, 0);
      for (let o = 0xB0; o < 0xE0; o += 2) io.write16(o, 0);
      for (let o = 0x100; o < 0x110; o += 2) io.write16(o, 0);
      io.write16(0x200, 0); io.write16(0x202, 0xFFFF); io.write16(0x208, 0);
      io.regs[0x20 >> 1] = 0x100; io.regs[0x26 >> 1] = 0x100;
      io.regs[0x30 >> 1] = 0x100; io.regs[0x36 >> 1] = 0x100;
      io.write16(0, 0x80);
    }
  }

  // Espera uma interrupção específica. Truque usado: o processador "dorme" e o PC
  // volta para a própria instrução SWI. Quando a interrupção acontece, o tratador
  // do jogo marca o bit em 0x03007FF8, a SWI roda de novo, vê o bit e segue em frente.
  intrWait(discard, flags, pc) {
    const g = this.gba, cpu = g.cpu, bus = g.bus;
    g.io.regs[0x104] = 1; g.updateIrq();
    let bif = bus.iwram16[0x7FF8 >> 1];
    if (!cpu.intrWaitActive) {
      cpu.intrWaitActive = true;
      if (discard) { bif &= ~flags; bus.iwram16[0x7FF8 >> 1] = bif; }
    }
    if (bif & flags) {
      bus.iwram16[0x7FF8 >> 1] = bif & ~flags;
      cpu.intrWaitActive = false;
      return;
    }
    cpu.halted = true;
    cpu.r[15] = pc; cpu.branched = true;
  }

  // Divisão inteira com sinal: r0 = quociente, r1 = resto, r3 = |quociente|.
  div(a, b) {
    const r = this.gba.cpu.r;
    if (b === 0) { r[0] = a < 0 ? -1 : 1; r[1] = a; r[3] = 1; return; }
    const q = (a / b) | 0;
    r[0] = q; r[1] = (a % b) | 0; r[3] = Math.abs(q);
  }

  // Copia ou preenche memória em blocos de 16 ou 32 bits.
  cpuSet(src, dst, ctrl, fast) {
    const bus = this.gba.bus;
    let cnt = ctrl & 0x1FFFFF;
    const fill = ctrl & 0x1000000;
    if (fast || (ctrl & 0x4000000)) {
      if (fast) cnt = (cnt + 7) & ~7;
      src &= ~3; dst &= ~3;
      if (fill) { const v = bus.read32(src >>> 0); for (let i = 0; i < cnt; i++) { bus.write32(dst >>> 0, v); dst += 4; } }
      else for (let i = 0; i < cnt; i++) { bus.write32(dst >>> 0, bus.read32(src >>> 0)); src += 4; dst += 4; }
      this.gba.cpu.extra += cnt * 2;
    } else {
      src &= ~1; dst &= ~1;
      if (fill) { const v = bus.read16(src >>> 0); for (let i = 0; i < cnt; i++) { bus.write16(dst >>> 0, v); dst += 2; } }
      else for (let i = 0; i < cnt; i++) { bus.write16(dst >>> 0, bus.read16(src >>> 0)); src += 2; dst += 2; }
      this.gba.cpu.extra += cnt * 2;
    }
  }

  // Calcula a matriz de rotação e escala (e o ponto inicial) de um fundo a partir de ângulo, zoom e centro.
  bgAffineSet(src, dst, n) {
    const bus = this.gba.bus;
    const s16 = (a) => (bus.read16(a >>> 0) << 16) >> 16;
    const s32 = (a) => bus.read32(a >>> 0) | 0;
    for (let i = 0; i < n; i++) {
      const ox = s32(src) / 256, oy = s32(src + 4) / 256;
      const cx = s16(src + 8), cy = s16(src + 10);
      const sx = s16(src + 12) / 256, sy = s16(src + 14) / 256;
      const theta = (bus.read16((src + 16) >>> 0) >>> 8) / 128 * Math.PI;
      let a = Math.cos(theta), b = Math.sin(theta), c = b, d = a;
      a *= sx; b *= -sx; c *= sy; d *= sy;
      const rx = ox - (a * cx + b * cy), ry = oy - (c * cx + d * cy);
      bus.write16(dst >>> 0, (a * 256) & 0xFFFF);
      bus.write16((dst + 2) >>> 0, (b * 256) & 0xFFFF);
      bus.write16((dst + 4) >>> 0, (c * 256) & 0xFFFF);
      bus.write16((dst + 6) >>> 0, (d * 256) & 0xFFFF);
      bus.write32((dst + 8) >>> 0, (rx * 256) | 0);
      bus.write32((dst + 12) >>> 0, (ry * 256) | 0);
      src += 20; dst += 16;
    }
  }

  // O mesmo para sprites: só a matriz 2×2 (pa, pb, pc, pd).
  objAffineSet(src, dst, n, diff) {
    const bus = this.gba.bus;
    const s16 = (a) => (bus.read16(a >>> 0) << 16) >> 16;
    for (let i = 0; i < n; i++) {
      const sx = s16(src) / 256, sy = s16(src + 2) / 256;
      const theta = (bus.read16((src + 4) >>> 0) >>> 8) / 128 * Math.PI;
      let a = Math.cos(theta), b = Math.sin(theta), c = b, d = a;
      a *= sx; b *= -sx; c *= sy; d *= sy;
      bus.write16(dst >>> 0, (a * 256) & 0xFFFF); dst += diff;
      bus.write16(dst >>> 0, (b * 256) & 0xFFFF); dst += diff;
      bus.write16(dst >>> 0, (c * 256) & 0xFFFF); dst += diff;
      bus.write16(dst >>> 0, (d * 256) & 0xFFFF); dst += diff;
      src += 8;
    }
  }

  // Expande dados de poucos bits por pixel para mais bits (ex.: fontes de 1 bit para 4 bits).
  bitUnpack(src, dst, info) {
    const bus = this.gba.bus;
    const len = bus.read16(info >>> 0), sw = bus.read8((info + 2) >>> 0), dw = bus.read8((info + 3) >>> 0);
    let off = bus.read32((info + 4) >>> 0);
    const zf = off >>> 31; off &= 0x7FFFFFFF;
    if (![1, 2, 4, 8].includes(sw) || ![1, 2, 4, 8, 16, 32].includes(dw)) return;
    const smask = (1 << sw) - 1;
    let out = 0, bits = 0;
    dst &= ~3;
    for (let i = 0; i < len; i++) {
      const byte = bus.read8((src + i) >>> 0);
      for (let b = 0; b < 8; b += sw) {
        let v = (byte >> b) & smask;
        if (v || zf) v += off;
        const dm = dw === 32 ? 0xFFFFFFFF : (1 << dw) - 1;
        out = (out | ((v & dm) << bits)) >>> 0;
        bits += dw;
        if (bits >= 32) { bus.write32(dst >>> 0, out); dst += 4; out = 0; bits = 0; }
      }
    }
  }

  // Grava o resultado de uma descompressão. Para a VRAM, grava de 16 em 16 bits (a VRAM não aceita bytes soltos).
  writeOut(dst, out, vram) {
    const bus = this.gba.bus;
    const reg = (dst >>> 24) & 15;
    if (vram || reg === 5 || reg === 6 || reg === 7) {
      dst &= ~1;
      for (let i = 0; i < out.length; i += 2) bus.write16((dst + i) >>> 0, out[i] | ((out[i + 1] || 0) << 8));
    } else if (reg === 2) {
      const base = dst & 0x3FFFF;
      if (base + out.length <= 0x40000) bus.ewram.set(out, base);
      else for (let i = 0; i < out.length; i++) bus.write8((dst + i) >>> 0, out[i]);
    } else if (reg === 3) {
      const base = dst & 0x7FFF;
      if (base + out.length <= 0x8000) bus.iwram.set(out, base);
      else for (let i = 0; i < out.length; i++) bus.write8((dst + i) >>> 0, out[i]);
    } else for (let i = 0; i < out.length; i++) bus.write8((dst + i) >>> 0, out[i]);
    this.gba.cpu.extra += out.length;
  }

  // Descompressão LZ77, a mais usada nos gráficos. Cada bit de "flags" diz se o
  // próximo item é um byte literal ou um "copie N bytes de X posições atrás".
  lz77(src, dst, vram) {
    const bus = this.gba.bus;
    const hdr = bus.read32(src >>> 0);
    const size = hdr >>> 8;
    if (size === 0 || size > 0x40000) return;
    const out = new Uint8Array(size);
    let o = 0; src += 4;
    while (o < size) {
      const flags = bus.read8((src++) >>> 0);
      for (let b = 7; b >= 0 && o < size; b--) {
        if (flags & (1 << b)) {
          const b1 = bus.read8((src++) >>> 0), b2 = bus.read8((src++) >>> 0);
          const disp = (((b1 & 0xF) << 8) | b2) + 1;
          let len = (b1 >> 4) + 3;
          while (len-- > 0 && o < size) { out[o] = o - disp >= 0 ? out[o - disp] : 0; o++; }
        } else out[o++] = bus.read8((src++) >>> 0);
      }
    }
    this.writeOut(dst, out, vram);
  }

  // Descompressão Huffman: percorre uma árvore bit a bit até chegar a um valor.
  huff(src, dst) {
    const bus = this.gba.bus;
    src &= ~3;
    const hdr = bus.read32(src >>> 0);
    const size = hdr >>> 8, bits = hdr & 15;
    if (size === 0 || size > 0x40000 || (bits !== 4 && bits !== 8)) return;
    const treeBase = src + 5;
    let bitSrc = src + 4 + ((bus.read8((src + 4) >>> 0) + 1) << 1);
    const out = new Uint8Array((size + 3) & ~3);
    let written = 0, outBuf = 0, outBits = 0;
    let nPtr = treeBase, node = bus.read8(treeBase >>> 0);
    let guard = 0;
    while (written < size && guard++ < 0x100000) {
      const word = bus.read32(bitSrc >>> 0); bitSrc += 4;
      for (let bit = 31; bit >= 0; bit--) {
        const next = (nPtr & ~1) + (node & 0x3F) * 2 + 2;
        let isData;
        if ((word >>> bit) & 1) { nPtr = next + 1; isData = node & 0x40; }
        else { nPtr = next; isData = node & 0x80; }
        node = bus.read8(nPtr >>> 0);
        if (isData) {
          outBuf = (outBuf | (node << outBits)) >>> 0; outBits += bits;
          nPtr = treeBase; node = bus.read8(treeBase >>> 0);
          if (outBits === 32) {
            out[written] = outBuf & 0xFF; out[written + 1] = (outBuf >>> 8) & 0xFF;
            out[written + 2] = (outBuf >>> 16) & 0xFF; out[written + 3] = outBuf >>> 24;
            written += 4; outBuf = 0; outBits = 0;
            if (written >= size) break;
          }
        }
      }
    }
    this.writeOut(dst, out.subarray(0, size), false);
  }

  // Descompressão RLE: sequências de bytes repetidos ou de bytes literais.
  rl(src, dst, vram) {
    const bus = this.gba.bus;
    const hdr = bus.read32(src >>> 0);
    const size = hdr >>> 8;
    if (size === 0 || size > 0x40000) return;
    const out = new Uint8Array(size);
    let o = 0; src += 4;
    while (o < size) {
      const f = bus.read8((src++) >>> 0);
      if (f & 0x80) {
        const len = (f & 0x7F) + 3, b = bus.read8((src++) >>> 0);
        for (let i = 0; i < len && o < size; i++) out[o++] = b;
      } else {
        const len = (f & 0x7F) + 1;
        for (let i = 0; i < len && o < size; i++) out[o++] = bus.read8((src++) >>> 0);
      }
    }
    this.writeOut(dst, out, vram);
  }

  // Filtro diferencial: cada valor guardado é a diferença em relação ao anterior.
  diff8(src, dst, vram) {
    const bus = this.gba.bus;
    const size = bus.read32(src >>> 0) >>> 8;
    if (size === 0 || size > 0x40000) return;
    const out = new Uint8Array(size);
    let acc = 0;
    for (let i = 0; i < size; i++) { acc = (acc + bus.read8((src + 4 + i) >>> 0)) & 0xFF; out[i] = acc; }
    this.writeOut(dst, out, vram);
  }
  diff16(src, dst) {
    const bus = this.gba.bus;
    const size = bus.read32(src >>> 0) >>> 8;
    if (size === 0 || size > 0x40000) return;
    let acc = 0;
    for (let i = 0; i < size; i += 2) {
      acc = (acc + bus.read16((src + 4 + i) >>> 0)) & 0xFFFF;
      bus.write16((dst + i) >>> 0, acc);
    }
  }
}
