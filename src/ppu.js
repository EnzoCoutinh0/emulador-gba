'use strict';
// =====================================================================
// ppu.js — O VÍDEO (PPU)
// =====================================================================
// A tela do GBA tem 240×160 pixels e é desenhada linha por linha, como
// numa TV antiga: 160 linhas visíveis + 68 "invisíveis" (VBlank).
// A imagem é composta por camadas:
//   • 4 fundos (BG0–BG3) feitos de blocos de 8×8 pixels (tiles), com rolagem.
//     Nos modos 1 e 2, alguns fundos podem girar e dar zoom ("afins").
//     Nos modos 3, 4 e 5 o fundo é uma imagem direta (bitmap).
//   • até 128 sprites (personagens, itens), que também podem girar.
// Depois vêm as janelas (recortam camadas) e os efeitos de cor
// (transparência, clarear e escurecer). Cada linha é composta em
// composite() e convertida em cores de 32 bits para o navegador.
// =====================================================================
// ===================== Vídeo (PPU) =====================
// Largura e altura dos sprites, por forma (quadrado, deitado, em pé) e tamanho (0–3).
const OBJ_W = [8, 16, 32, 64, 16, 32, 32, 64, 8, 8, 16, 32];
const OBJ_H = [8, 16, 32, 64, 8, 8, 16, 32, 16, 32, 32, 64];

class PPU {
  // frame = imagem final (RGBA); bgLine/objColor = cor de cada pixel da linha por camada (-1 = transparente);
  // lut = tabela que converte as cores de 15 bits do GBA (5 bits por canal) para 32 bits.
  constructor(gba) {
    this.gba = gba;
    this.vcount = 0;
    this.stat = 0;
    this.frameBuf = new ArrayBuffer(240 * 160 * 4);
    this.frame = new Uint32Array(this.frameBuf);
    this.bgLine = [new Int32Array(240), new Int32Array(240), new Int32Array(240), new Int32Array(240)];
    this.objColor = new Int32Array(240);
    this.objPrio = new Uint8Array(240);
    this.objSemi = new Uint8Array(240);
    this.objWin = new Uint8Array(240);
    this.refX = new Int32Array(2); this.refY = new Int32Array(2);
    this.lut = new Uint32Array(32768);
    for (let c = 0; c < 32768; c++) {
      const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
      this.lut[c] = (0xFF000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2))) >>> 0;
    }
    this.order = new Int32Array(4);
    this.winMask = new Uint8Array(240);
  }
  reset() { this.vcount = 0; this.stat = 0; this.frame.fill(0xFF000000); this.refX.fill(0); this.refY.fill(0); }

  // Fundos afins têm um ponto de referência interno, recarregado no início do quadro ou quando o jogo o altera.
  loadRef(i) {
    const regs = this.gba.io.regs, b = i ? 0x1C : 0x14;
    this.refX[i] = ((regs[b] | (regs[b + 1] << 16)) << 4) >> 4;
    this.refY[i] = ((regs[b + 2] | (regs[b + 3] << 16)) << 4) >> 4;
  }
  // A cada linha, o ponto de referência anda (pb, pd), como o hardware faz. É isso que permite efeitos como o "Mode 7".
  stepRefs() {
    const regs = this.gba.io.regs;
    this.refX[0] += (regs[0x11] << 16) >> 16; this.refY[0] += (regs[0x13] << 16) >> 16;
    this.refX[1] += (regs[0x19] << 16) >> 16; this.refY[1] += (regs[0x1B] << 16) >> 16;
  }

  // Desenha a linha y: cada fundo ligado, os sprites e, por fim, a composição.
  // Bit 7 do DISPCNT = tela forçada em branco.
  renderLine(y) {
    const regs = this.gba.io.regs;
    const dispcnt = regs[0];
    const out = this.frame, base = y * 240;
    if (dispcnt & 0x80) { out.fill(0xFFFFFFFF, base, base + 240); return; }
    const mode = dispcnt & 7;
    let bgEn = (dispcnt >>> 8) & 0xF;
    if (mode === 1) bgEn &= 7; else if (mode === 2) bgEn &= 0xC; else if (mode >= 3) bgEn &= 4;
    for (let bg = 0; bg < 4; bg++) {
      if (!(bgEn & (1 << bg))) continue;
      if (mode === 0 || (mode === 1 && bg < 2)) this.renderText(bg, y);
      else if (mode <= 2) this.renderAffine(bg, y);
      else this.renderBitmap(mode, dispcnt, y);
    }
    this.objColor.fill(-1); this.objWin.fill(0);
    if (dispcnt & 0x1000) this.renderSprites(y, mode, dispcnt);
    this.composite(y, bgEn, dispcnt);
  }

  // Efeito mosaico: repete cada pixel mh vezes na horizontal (usado em transições).
  mosaicLine(line, mh) {
    if (mh <= 1) return;
    for (let x = 0; x < 240; x++) { const m = x % mh; if (m) line[x] = line[x - m]; }
  }

  // Fundo de tiles ("texto"). O mapa (screen base) diz qual tile vai em cada
  // posição 8×8, com espelhamento e paleta. Os pixels do tile ficam no char base:
  // 4 bits por pixel (16 cores) ou 8 bits (256 cores). Cor 0 = transparente.
  // Desenha um tile (até 8 pixels) por vez, o que é bem mais rápido que pixel a pixel.
  renderText(bg, y) {
    const bus = this.gba.bus, regs = this.gba.io.regs, vram = bus.vram, vram16 = bus.vram16, pal = bus.pal16;
    const cnt = regs[4 + bg];
    const hofs = regs[8 + bg * 2] & 0x1FF, vofs = regs[9 + bg * 2] & 0x1FF;
    const charBase = ((cnt >>> 2) & 3) * 0x4000, screenBase = ((cnt >>> 8) & 0x1F) * 0x800;
    const c256 = cnt & 0x80, size = (cnt >>> 14) & 3;
    const wide = size & 1, tall = size & 2;
    const mos = regs[0x26];
    let yy = y;
    if (cnt & 0x40) { const mv = ((mos >>> 4) & 15) + 1; yy -= yy % mv; }
    const py = (yy + vofs) & (tall ? 511 : 255);
    const ty = (py >>> 3) & 31, fy = py & 7;
    let rowBlock = 0;
    if (py >= 256) rowBlock = wide ? 2 : 1;
    const line = this.bgLine[bg];
    const wmask = wide ? 511 : 255;
    let x = 0, px = hofs & wmask;
    while (x < 240) {
      const blk = rowBlock + (px >= 256 ? 1 : 0);
      const ent = vram16[(screenBase + blk * 0x800 + ((ty * 32 + ((px >>> 3) & 31)) << 1)) >> 1];
      const tile = ent & 0x3FF, hf = (ent & 0x400) !== 0;
      const row = (ent & 0x800) ? 7 - fy : fy;
      let fx = px & 7;
      const n = Math.min(8 - fx, 240 - x);
      if (c256) {
        const ta = charBase + tile * 64 + row * 8;
        if (ta + 8 > 0x10000) { for (let k = 0; k < n; k++) line[x++] = -1; }
        else for (let k = 0; k < n; k++, fx++) {
          const idx = vram[ta + (hf ? 7 - fx : fx)];
          line[x++] = idx ? pal[idx] & 0x7FFF : -1;
        }
      } else {
        const ta = charBase + tile * 32 + row * 4;
        const pb = (ent >>> 12) << 4;
        if (ta + 4 > 0x10000) { for (let k = 0; k < n; k++) line[x++] = -1; }
        else {
          const bits = vram[ta] | (vram[ta + 1] << 8) | (vram[ta + 2] << 16) | (vram[ta + 3] << 24);
          if (bits === 0) { for (let k = 0; k < n; k++) line[x++] = -1; }
          else for (let k = 0; k < n; k++, fx++) {
            const idx = (bits >>> ((hf ? 7 - fx : fx) << 2)) & 15;
            line[x++] = idx ? pal[pb + idx] & 0x7FFF : -1;
          }
        }
      }
      px = (px + n) & wmask;
    }
    if (cnt & 0x40) this.mosaicLine(line, (mos & 15) + 1);
  }

  // Fundo afim (gira e dá zoom): para cada pixel da tela, a matriz (pa, pc)
  // calcula qual pixel do mapa mostrar. Pode repetir (wrap) ou ficar transparente fora do mapa.
  renderAffine(bg, y) {
    const bus = this.gba.bus, regs = this.gba.io.regs, vram = bus.vram, pal = bus.pal16;
    const cnt = regs[4 + bg];
    const size = 128 << ((cnt >>> 14) & 3), tpr = size >>> 3, smask = size - 1;
    const charBase = ((cnt >>> 2) & 3) * 0x4000, screenBase = ((cnt >>> 8) & 0x1F) * 0x800;
    const wrap = cnt & 0x2000;
    const pi = bg === 2 ? 0x10 : 0x18;
    const pa = (regs[pi] << 16) >> 16, pc = (regs[pi + 2] << 16) >> 16;
    let x = this.refX[bg - 2], yv = this.refY[bg - 2];
    const line = this.bgLine[bg];
    for (let i = 0; i < 240; i++, x += pa, yv += pc) {
      let tx = x >> 8, ty = yv >> 8;
      if (wrap) { tx &= smask; ty &= smask; }
      else if (tx < 0 || ty < 0 || tx >= size || ty >= size) { line[i] = -1; continue; }
      const tile = vram[screenBase + (ty >>> 3) * tpr + (tx >>> 3)];
      const idx = vram[charBase + tile * 64 + (ty & 7) * 8 + (tx & 7)];
      line[i] = idx ? pal[idx] & 0x7FFF : -1;
    }
    if (cnt & 0x40) this.mosaicLine(line, (regs[0x26] & 15) + 1);
  }

  // Modos bitmap: 3 = 240×160 em 15 bits; 4 = 240×160 com paleta (2 páginas); 5 = 160×128 em 15 bits (2 páginas).
  renderBitmap(mode, dispcnt, y) {
    const bus = this.gba.bus, regs = this.gba.io.regs, vram = bus.vram, vram16 = bus.vram16, pal = bus.pal16;
    const pa = (regs[0x10] << 16) >> 16, pc = (regs[0x12] << 16) >> 16;
    let x = this.refX[0], yv = this.refY[0];
    const line = this.bgLine[2];
    const page = (dispcnt & 0x10) ? 0xA000 : 0;
    const w = mode === 5 ? 160 : 240, h = mode === 5 ? 128 : 160;
    for (let i = 0; i < 240; i++, x += pa, yv += pc) {
      const tx = x >> 8, ty = yv >> 8;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) { line[i] = -1; continue; }
      if (mode === 3) line[i] = vram16[ty * 240 + tx] & 0x7FFF;
      else if (mode === 4) { const idx = vram[page + ty * 240 + tx]; line[i] = idx ? pal[idx] & 0x7FFF : -1; }
      else line[i] = vram16[(page >> 1) + ty * 160 + tx] & 0x7FFF;
    }
  }

  // Sprites da linha. Para cada um dos 128, a OAM diz posição, tamanho, tile,
  // paleta, prioridade e modo (normal, semitransparente ou "janela de objeto").
  // Os afins usam uma matriz 2×2 guardada na própria OAM. Em caso de empate,
  // o sprite de menor número fica na frente. Um pixel já coberto por um sprite
  // mais prioritário é pulado sem ler a VRAM (otimização).
  renderSprites(y, mode, dispcnt) {
    const bus = this.gba.bus, regs = this.gba.io.regs, oam = bus.oam16, vram = bus.vram, pal = bus.pal16;
    const map1D = dispcnt & 0x40;
    const mos = regs[0x26];
    const mh = ((mos >>> 8) & 15) + 1, mv = ((mos >>> 12) & 15) + 1;
    const oc = this.objColor, op = this.objPrio, os = this.objSemi, ow = this.objWin;
    for (let i = 0; i < 128; i++) {
      const a0 = oam[i * 4], a1 = oam[i * 4 + 1], a2 = oam[i * 4 + 2];
      const affine = a0 & 0x100;
      if (!affine && (a0 & 0x200)) continue;
      const om = (a0 >>> 10) & 3;
      if (om === 3) continue;
      const shape = a0 >>> 14;
      if (shape === 3) continue;
      const si = shape * 4 + (a1 >>> 14);
      const w = OBJ_W[si], h = OBJ_H[si];
      const dbl = affine && (a0 & 0x200);
      const bw = dbl ? w * 2 : w, bh = dbl ? h * 2 : h;
      let sy = a0 & 0xFF;
      if (sy + bh > 256) sy -= 256;
      let ly = y - sy;
      if (ly < 0 || ly >= bh) continue;
      let sx = a1 & 0x1FF;
      if (sx >= 240) sx -= 512;
      if (sx + bw <= 0) continue;
      const c256 = a0 & 0x2000;
      const tileBase = a2 & 0x3FF;
      if (mode >= 3 && tileBase < 512) continue;
      const prio = (a2 >>> 10) & 3, palb = 256 + ((a2 >>> 12) << 4);
      const mosaic = a0 & 0x1000;
      if (mosaic) ly -= ly % mv;
      const rowTiles = map1D ? (c256 ? (w >> 3) * 2 : (w >> 3)) : 32;
      if (affine) {
        const p = ((a1 >>> 9) & 31) * 16;
        const pa = (oam[p + 3] << 16) >> 16, pb = (oam[p + 7] << 16) >> 16, pc = (oam[p + 11] << 16) >> 16, pd = (oam[p + 15] << 16) >> 16;
        const hw = bw >> 1, hh = bh >> 1, iy = ly - hh;
        for (let ix = -hw; ix < hw; ix++) {
          const x = sx + ix + hw;
          if (x < 0 || x >= 240) continue;
          if (om !== 2 && oc[x] >= 0 && prio >= op[x]) continue;
          const tx = ((pa * ix + pb * iy) >> 8) + (w >> 1);
          const ty = ((pc * ix + pd * iy) >> 8) + (h >> 1);
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          let color, idx;
          if (c256) {
            const tile = tileBase + (ty >> 3) * rowTiles + (tx >> 3) * 2;
            idx = vram[0x10000 + ((tile & 0x3FF) << 5) + ((ty & 7) << 3) + (tx & 7)];
            color = pal[256 + idx];
          } else {
            const tile = tileBase + (ty >> 3) * rowTiles + (tx >> 3);
            const b = vram[0x10000 + ((tile & 0x3FF) << 5) + ((ty & 7) << 2) + ((tx & 7) >> 1)];
            idx = (tx & 1) ? b >> 4 : b & 15;
            color = pal[palb + idx];
          }
          if (!idx) continue;
          if (om === 2) { ow[x] = 1; continue; }
          if (oc[x] < 0 || prio < op[x]) { oc[x] = color & 0x7FFF; op[x] = prio; os[x] = om === 1 ? 1 : 0; }
        }
      } else {
        const hf = a1 & 0x1000, vf = a1 & 0x2000;
        const ty = vf ? h - 1 - ly : ly;
        const ix0 = sx < 0 ? -sx : 0, ix1 = sx + w > 240 ? 240 - sx : w;
        for (let ix = ix0; ix < ix1; ix++) {
          const x = sx + ix;
          if (om !== 2 && oc[x] >= 0 && prio >= op[x]) continue;
          let tx = hf ? w - 1 - ix : ix;
          if (mosaic && mh > 1) { const m = ix % mh; tx = hf ? w - 1 - (ix - m) : ix - m; }
          let color, idx;
          if (c256) {
            const tile = tileBase + (ty >> 3) * rowTiles + (tx >> 3) * 2;
            idx = vram[0x10000 + ((tile & 0x3FF) << 5) + ((ty & 7) << 3) + (tx & 7)];
            color = pal[256 + idx];
          } else {
            const tile = tileBase + (ty >> 3) * rowTiles + (tx >> 3);
            const b = vram[0x10000 + ((tile & 0x3FF) << 5) + ((ty & 7) << 2) + ((tx & 7) >> 1)];
            idx = (tx & 1) ? b >> 4 : b & 15;
            color = pal[palb + idx];
          }
          if (!idx) continue;
          if (om === 2) { ow[x] = 1; continue; }
          if (oc[x] < 0 || prio < op[x]) { oc[x] = color & 0x7FFF; op[x] = prio; os[x] = om === 1 ? 1 : 0; }
        }
      }
    }
  }

  // Composição: para cada pixel, encontra as duas camadas visíveis mais da frente
  // (pela prioridade 0–3; sprite ganha de fundo na mesma prioridade) e aplica
  // o efeito do BLDCNT: mistura alfa (eva/evb), clarear ou escurecer (evy).
  // A máscara da janela diz quais camadas e efeitos valem em cada ponto.
  composite(y, bgEn, dispcnt) {
    const regs = this.gba.io.regs, pal = this.gba.bus.pal16;
    const out = this.frame, lut = this.lut, base = y * 240;
    const winIn = regs[0x24], winOut = regs[0x25];
    const bldcnt = regs[0x28], bldalpha = regs[0x29], bldy = regs[0x2A];
    const effect = (bldcnt >>> 6) & 3;
    const eva = Math.min(16, bldalpha & 31), evb = Math.min(16, (bldalpha >>> 8) & 31), evy = Math.min(16, bldy & 31);
    const backdrop = pal[0] & 0x7FFF;
    const winOn = dispcnt & 0xE000;
    const wm = this.winMask;
    if (winOn) this.buildWindow(y, dispcnt, winIn, winOut); else wm.fill(0x3F);
    // ordem dos BGs por prioridade
    const order = this.order; let n = 0;
    for (let p = 0; p < 4; p++) for (let bg = 0; bg < 4; bg++) if ((bgEn & (1 << bg)) && (regs[4 + bg] & 3) === p) order[n++] = bg;
    const prioOf = [regs[4] & 3, regs[5] & 3, regs[6] & 3, regs[7] & 3];
    const L = this.bgLine, oc = this.objColor, op = this.objPrio, os = this.objSemi, ow = this.objWin;
    for (let x = 0; x < 240; x++) {
      const mask = wm[x];
      let c1 = backdrop, l1 = 5, c2 = backdrop, l2 = 5, found = 0;
      const ocx = (mask & 0x10) ? oc[x] : -1;
      let objDone = ocx < 0;
      const opx = op[x];
      for (let k = 0; k < n && found < 2; k++) {
        const bg = order[k];
        if (!objDone && opx <= prioOf[bg]) {
          objDone = true;
          if (found === 0) { c1 = ocx; l1 = 4; found = 1; } else { c2 = ocx; l2 = 4; found = 2; break; }
        }
        if (mask & (1 << bg)) {
          const c = L[bg][x];
          if (c >= 0) { if (found === 0) { c1 = c; l1 = bg; found = 1; } else { c2 = c; l2 = bg; found = 2; } }
        }
      }
      if (found < 2 && !objDone) { if (found === 0) { c1 = ocx; l1 = 4; found = 1; } else { c2 = ocx; l2 = 4; found = 2; } }
      let res = c1;
      if (l1 === 4 && os[x] && found >= 1 && (bldcnt & (0x100 << l2))) res = this.blend(c1, c2, eva, evb);
      else if ((mask & 0x20) && effect && (bldcnt & (1 << l1))) {
        if (effect === 1) { if (bldcnt & (0x100 << l2)) res = this.blend(c1, c2, eva, evb); }
        else if (effect === 2) {
          const r = c1 & 31, g = (c1 >> 5) & 31, b = (c1 >> 10) & 31;
          res = (r + (((31 - r) * evy) >> 4)) | ((g + (((31 - g) * evy) >> 4)) << 5) | ((b + (((31 - b) * evy) >> 4)) << 10);
        } else {
          const r = c1 & 31, g = (c1 >> 5) & 31, b = (c1 >> 10) & 31;
          res = (r - ((r * evy) >> 4)) | ((g - ((g * evy) >> 4)) << 5) | ((b - ((b * evy) >> 4)) << 10);
        }
      }
      out[base + x] = lut[res & 0x7FFF];
    }
  }

  // Calcula, para a linha toda, qual janela vale em cada x: WIN0 > WIN1 > janela de objeto > fora.
  buildWindow(y, dispcnt, winIn, winOut) {
    const regs = this.gba.io.regs, wm = this.winMask, ow = this.objWin;
    wm.fill(winOut & 0x3F);
    if (dispcnt & 0x8000) { const m = (winOut >>> 8) & 0x3F; for (let x = 0; x < 240; x++) if (ow[x]) wm[x] = m; }
    const apply = (hreg, vreg, m) => {
      const v = regs[vreg], y1 = v >>> 8; let y2 = v & 0xFF; if (y2 > 160) y2 = 160;
      if (!(y1 <= y2 ? (y >= y1 && y < y2) : (y >= y1 || y < y2))) return;
      const h = regs[hreg], x1 = h >>> 8, x2 = Math.min(240, h & 0xFF);
      if (x1 <= x2) wm.fill(m, x1, x2);
      else { wm.fill(m, x1, 240); wm.fill(m, 0, x2); }
    };
    if (dispcnt & 0x4000) apply(0x21, 0x23, (winIn >>> 8) & 0x3F);
    if (dispcnt & 0x2000) apply(0x20, 0x22, winIn & 0x3F);
  }

  // Mistura duas cores: (a×eva + b×evb) / 16, canal por canal, limitado a 31.
  blend(a, b, eva, evb) {
    let r = ((a & 31) * eva + (b & 31) * evb) >> 4; if (r > 31) r = 31;
    let g = (((a >> 5) & 31) * eva + ((b >> 5) & 31) * evb) >> 4; if (g > 31) g = 31;
    let bl = (((a >> 10) & 31) * eva + ((b >> 10) & 31) * evb) >> 4; if (bl > 31) bl = 31;
    return r | (g << 5) | (bl << 10);
  }
}
