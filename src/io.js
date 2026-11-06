'use strict';
// =====================================================================
// io.js — REGISTRADORES DE I/O, DMA E TIMERS
// =====================================================================
// Os registradores de I/O (0x04000000–0x040003FF) são o "painel de
// controle" do GBA. O jogo escreve neles para configurar tela, som,
// timers, DMA e interrupções, e lê deles o estado da tela e dos botões.
// Todos ficam em regs (Uint16Array, índice = endereço / 2).
// =====================================================================
// ===================== Registradores de I/O, DMA e timers =====================
class IO {
  constructor(gba) {
    this.gba = gba;
    this.regs = new Uint16Array(0x200);
    this.keys = 0x3FF;
  }
  reset() {
    this.regs.fill(0);
    this.regs[0] = 0x0080;
    this.regs[0x88 >> 1] = 0x0200; // SOUNDBIAS
    this.regs[0x134 >> 1] = 0x8000; // RCNT
    this.regs[0x20 >> 1] = 0x100; this.regs[0x26 >> 1] = 0x100;
    this.regs[0x30 >> 1] = 0x100; this.regs[0x36 >> 1] = 0x100;
    this.regs[0] = 0;
  }
  // IE = interrupções habilitadas; IF = interrupções pedidas (pendentes).
  get IE() { return this.regs[0x100]; }
  get IF() { return this.regs[0x101]; }

  read8(o) {
    if (o >= 0x400) return 0;
    return (this.read16(o & ~1) >>> ((o & 1) << 3)) & 0xFF;
  }
  // Leitura de registrador. A maioria devolve o valor guardado, mas alguns são calculados na hora:
  // DISPSTAT (estado da tela), VCOUNT (linha atual), contadores dos timers e KEYINPUT (botões; 0 = apertado).
  // Registradores "só de escrita" devolvem 0, como no hardware.
  read16(o) {
    if (o >= 0x400) return 0;
    const g = this.gba;
    switch (o) {
      case 0x004: return (this.regs[2] & 0xFFF8) | g.ppu.stat;
      case 0x006: return g.ppu.vcount;
      case 0x100: return g.timers.read(0);
      case 0x104: return g.timers.read(1);
      case 0x108: return g.timers.read(2);
      case 0x10C: return g.timers.read(3);
      case 0x130: return this.keys;
      case 0x084: return (this.regs[0x42] & 0x80) | g.apu.status();
      // registradores só de escrita
      case 0x010: case 0x012: case 0x014: case 0x016: case 0x018: case 0x01A: case 0x01C: case 0x01E:
      case 0x040: case 0x042: case 0x044: case 0x046: case 0x04C: case 0x054:
        return 0;
    }
    if (o >= 0x20 && o < 0x40) return 0;
    if (o >= 0x90 && o < 0xA0) return g.apu.readWave(o);
    if (o >= 0xA0 && o < 0xA8) return 0;
    if (o >= 0xB0 && o < 0xE0) {
      const rel = (o - 0xB0) % 12;
      if (rel === 10) return this.regs[o >> 1];
      return 0;
    }
    return this.regs[o >> 1];
  }

  // Escrita de 8 bits: casos especiais (HALTCNT faz o processador dormir; IF apaga pedidos
  // de interrupção; FIFO de som recebe bytes). O resto vira uma escrita de 16 bits.
  write8(o, v) {
    if (o >= 0x400) return;
    if (o === 0x301) { this.gba.cpu.halted = true; return; }
    if (o === 0x202 || o === 0x203) {
      this.regs[0x101] &= ~(v << ((o & 1) << 3));
      this.gba.updateIrq(); return;
    }
    if (o >= 0xA0 && o < 0xA8) { this.gba.apu.fifoPush(o >= 0xA4 ? 1 : 0, v); return; }
    const cur = this.regs[o >> 1];
    const nv = (o & 1) ? ((cur & 0x00FF) | (v << 8)) : ((cur & 0xFF00) | v);
    this.write16(o & ~1, nv, (o & 1) ? 2 : 1);
  }

  // part: 1 = só byte baixo escrito, 2 = só byte alto, 3 = ambos
  // Escrita de 16 bits com os efeitos colaterais de cada registrador:
  //   0x028–0x03E: pontos de referência dos fundos rotacionáveis (recarregados na hora)
  //   0x0A0–0x0A6: filas (FIFO) de som digital
  //   0x0BA/0xC6/0xD2/0xDE: controle dos 4 canais de DMA
  //   0x100–0x10E: timers     0x200/0x202/0x208: interrupções (IE, IF, IME)
  //   0x204: velocidade do cartucho (WAITCNT)   0x300: dormir (HALT)
  write16(o, v, part = 3) {
    if (o >= 0x400) return;
    const g = this.gba, regs = this.regs;
    switch (o) {
      case 0x004: regs[2] = (regs[2] & 7) | (v & 0xFF38); return;
      case 0x006: return;
      case 0x028: case 0x02A: regs[o >> 1] = v; g.ppu.loadRef(0); return;
      case 0x02C: case 0x02E: regs[o >> 1] = v; g.ppu.loadRef(0); return;
      case 0x038: case 0x03A: regs[o >> 1] = v; g.ppu.loadRef(1); return;
      case 0x03C: case 0x03E: regs[o >> 1] = v; g.ppu.loadRef(1); return;
      case 0x0A0: case 0x0A2: g.apu.fifoPush(0, v & 0xFF); g.apu.fifoPush(0, v >>> 8); return;
      case 0x0A4: case 0x0A6: g.apu.fifoPush(1, v & 0xFF); g.apu.fifoPush(1, v >>> 8); return;
      case 0x0BA: g.dma.writeCtrl(0, v); return;
      case 0x0C6: g.dma.writeCtrl(1, v); return;
      case 0x0D2: g.dma.writeCtrl(2, v); return;
      case 0x0DE: g.dma.writeCtrl(3, v); return;
      case 0x100: case 0x102: case 0x104: case 0x106: case 0x108: case 0x10A: case 0x10C: case 0x10E:
        g.timers.write(o, v); regs[o >> 1] = v; return;
      case 0x128: regs[0x94] = v; g.serialWrite(v); return;
      case 0x130: return;
      case 0x132: regs[0x99] = v; g.checkKeyIrq(); return;
      case 0x200: regs[0x100] = v; g.updateIrq(); return;
      case 0x202: regs[0x101] &= ~v; g.updateIrq(); return;
      case 0x204: regs[0x102] = v; g.bus.updateWaitstates(v); return;
      case 0x208: regs[0x104] = v & 1; g.updateIrq(); return;
      case 0x300: regs[0x180] = v; if (part & 2) g.cpu.halted = true; return;
    }
    if (o >= 0x60 && o < 0xA0) { g.apu.write(o, v); return; }
    regs[o >> 1] = v;
  }
}

// ---------------------------------------------------------------------
// DMA: 4 canais que copiam memória sem usar o processador.
// Quando copiam: na hora (timing 0), no início do VBlank (1), no fim de
// cada linha visível/HBlank (2) ou em modo especial (3 = alimentar as filas de som).
// ---------------------------------------------------------------------
class DMA {
  constructor(gba) {
    this.gba = gba;
    this.src = new Uint32Array(4); this.dst = new Uint32Array(4); this.count = new Uint32Array(4);
    this.ctrl = new Uint16Array(4); this.active = new Uint8Array(4);
  }
  reset() { this.src.fill(0); this.dst.fill(0); this.count.fill(0); this.ctrl.fill(0); this.active.fill(0); }
  regBase(i) { return (0xB0 + i * 12) >> 1; }
  // Lê quantas unidades copiar. 0 significa o máximo (0x4000 nos canais 0–2, 0x10000 no canal 3).
  latchCount(i) {
    const regs = this.gba.io.regs, b = this.regBase(i);
    let cnt = regs[b + 4];
    if (i < 3) cnt &= 0x3FFF;
    if (cnt === 0) cnt = i === 3 ? 0x10000 : 0x4000;
    this.count[i] = cnt;
  }
  latchDst(i) {
    const regs = this.gba.io.regs, b = this.regBase(i);
    this.dst[i] = ((regs[b + 2] | (regs[b + 3] << 16)) >>> 0) & (i === 3 ? 0x0FFFFFFF : 0x07FFFFFF);
  }
  // Quando o bit 15 (ligar) passa de 0 para 1, o DMA "trava" origem, destino e quantidade, e começa se for imediato.
  writeCtrl(i, v) {
    const regs = this.gba.io.regs, b = this.regBase(i);
    const was = this.ctrl[i] & 0x8000;
    this.ctrl[i] = v; regs[b + 5] = v;
    if (!(v & 0x8000)) { this.active[i] = 0; return; }
    if (!was) {
      this.src[i] = ((regs[b] | (regs[b + 1] << 16)) >>> 0) & (i === 0 ? 0x07FFFFFF : 0x0FFFFFFF);
      this.latchDst(i);
      this.latchCount(i);
      this.active[i] = 1;
      if (((v >>> 12) & 3) === 0) this.run(i);
    }
  }
  // Chamado pela máquina no VBlank e no HBlank: dispara os canais que esperam aquele momento.
  trigger(timing) {
    for (let i = 0; i < 4; i++) {
      if (this.active[i] && ((this.ctrl[i] >>> 12) & 3) === timing) this.run(i);
    }
  }
  // A fila de som pediu mais amostras: dispara o DMA de som que aponta para ela.
  fifoRequest(addr) {
    for (let i = 1; i <= 2; i++) {
      if (this.active[i] && ((this.ctrl[i] >>> 12) & 3) === 3 && this.dst[i] === addr) this.run(i);
    }
  }
  // Faz a cópia. Origem e destino podem avançar, voltar ou ficar fixos. O DMA de som sempre copia
  // 4 palavras de 32 bits. No fim, pode gerar interrupção e, se for repetitivo, recarrega para a próxima vez.
  run(i) {
    const g = this.gba, bus = g.bus, ctrl = this.ctrl[i];
    const timing = (ctrl >>> 12) & 3;
    const sound = (i === 1 || i === 2) && timing === 3;
    const word = sound || (ctrl & 0x400) !== 0;
    const count = sound ? 4 : this.count[i];
    const dctl = (ctrl >>> 5) & 3, sctl = (ctrl >>> 7) & 3;
    const size = word ? 4 : 2;
    const sstep = sctl === 1 ? -size : sctl === 2 ? 0 : size;
    const dstep = sound ? 0 : (dctl === 1 ? -size : dctl === 2 ? 0 : size);
    let s = this.src[i], d = this.dst[i];
    if (bus.eepromMode && ((d >>> 24) === 13 || (s >>> 24) === 13)) g.save.eepromDmaCount(count);
    if (word) {
      for (let n = 0; n < count; n++) { bus.write32(d & ~3, bus.read32(s & ~3)); s += sstep; d += dstep; }
    } else {
      for (let n = 0; n < count; n++) { bus.write16(d & ~1, bus.read16(s & ~1)); s += sstep; d += dstep; }
    }
    this.src[i] = s >>> 0; this.dst[i] = d >>> 0;
    g.dmaCycles += count * (word ? 4 : 2) + 2;
    if (ctrl & 0x4000) g.requestIrq(1 << (8 + i));
    if ((ctrl & 0x200) && timing !== 0) {
      if (!sound) this.latchCount(i);
      if (dctl === 3) this.latchDst(i);
    } else {
      this.active[i] = 0;
      this.ctrl[i] = ctrl & 0x7FFF;
      g.io.regs[this.regBase(i) + 5] = this.ctrl[i];
    }
  }
}

// ---------------------------------------------------------------------
// TIMERS: 4 contadores de 16 bits. Cada um sobe 1 a cada 1, 64, 256 ou
// 1024 ciclos (TIMER_SHIFT = log2 desses valores). Ao estourar (passar de
// 0xFFFF), volta ao valor de recarga e pode: gerar interrupção, puxar
// a próxima amostra de som e avançar o próximo timer (modo cascata).
// ---------------------------------------------------------------------
const TIMER_SHIFT = [0, 6, 8, 10];
class Timers {
  constructor(gba) {
    this.gba = gba;
    this.counter = new Uint32Array(4); this.reload = new Uint32Array(4);
    this.ctrl = new Uint16Array(4); this.acc = new Uint32Array(4);
    this.active = 0; this.pend = 0; this.until = 0x7FFFFFFF;
  }
  reset() { this.counter.fill(0); this.reload.fill(0); this.ctrl.fill(0); this.acc.fill(0); this.active = 0; this.pend = 0; this.until = 0x7FFFFFFF; }
  read(i) { this.flush(); return this.counter[i]; }
  write(o, v) {
    this.flush();
    const i = (o - 0x100) >> 2;
    if (o & 2) {
      const was = this.ctrl[i] & 0x80;
      this.ctrl[i] = v;
      if (!was && (v & 0x80)) { this.counter[i] = this.reload[i]; this.acc[i] = 0; }
      let a = 0;
      for (let k = 0; k < 4; k++) if ((this.ctrl[k] & 0x80) && !(k > 0 && (this.ctrl[k] & 4))) a = 1;
      this.active = a;
    } else this.reload[i] = v;
    this.calcUntil();
  }
  // Otimização: em vez de atualizar os timers a cada instrução, só acumulamos os ciclos (pend)
  // e processamos quando falta pouco para algum estourar (until) ou quando o jogo lê um contador.
  tick(c) { this.pend += c; if (this.pend >= this.until) this.flush(); }
  flush() {
    const c = this.pend;
    if (c) { this.pend = 0; this.doTick(c); }
    this.calcUntil();
  }
  // Calcula quantos ciclos faltam até o primeiro estouro entre os timers ligados.
  calcUntil() {
    let u = 0x7FFFFFFF;
    for (let i = 0; i < 4; i++) {
      const ct = this.ctrl[i];
      if (!(ct & 0x80) || (i > 0 && (ct & 4))) continue;
      const left = ((0x10000 - this.counter[i]) << TIMER_SHIFT[ct & 3]) - this.acc[i];
      if (left < u) u = left;
    }
    this.until = u < 1 ? 1 : u;
  }
  doTick(c) {
    for (let i = 0; i < 4; i++) {
      const ct = this.ctrl[i];
      if (!(ct & 0x80) || (i > 0 && (ct & 4))) continue;
      const sh = TIMER_SHIFT[ct & 3];
      let acc = this.acc[i] + c;
      if (acc >= (1 << sh)) {
        const inc = acc >>> sh;
        acc &= (1 << sh) - 1;
        this.acc[i] = acc;
        this.add(i, inc);
      } else this.acc[i] = acc;
    }
  }
  // Soma ao contador e trata cada estouro (podem ser vários, se a recarga for alta).
  add(i, inc) {
    let v = this.counter[i] + inc;
    if (v > 0xFFFF) {
      const period = 0x10000 - this.reload[i];
      while (v > 0xFFFF) { v -= period; this.counter[i] = v > 0xFFFF ? 0xFFFF : v; this.overflow(i); }
    }
    this.counter[i] = v;
  }
  // O que acontece num estouro: interrupção, som (timers 0 e 1) e cascata para o próximo timer.
  overflow(i) {
    const g = this.gba;
    if (this.ctrl[i] & 0x40) g.requestIrq(8 << i);
    if (i < 2) g.apu.timerOverflow(i);
    if (i < 3) { const n = this.ctrl[i + 1]; if ((n & 0x84) === 0x84) this.add(i + 1, 1); }
  }
}
