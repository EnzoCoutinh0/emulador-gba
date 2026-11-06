'use strict';
// =====================================================================
// gba.js — A MÁQUINA COMPLETA
// =====================================================================
// Junta todas as peças (memória, CPU, vídeo, som, DMA, timers, BIOS,
// save e relógio) e controla o tempo. Um quadro do GBA dura 280.896
// ciclos: 228 linhas × 1.232 ciclos. Cada linha tem 960 ciclos
// desenhando (HDraw) e 272 de pausa (HBlank). As linhas 160 a 227 são o
// VBlank, quando a tela não é desenhada e os jogos atualizam os gráficos.
// =====================================================================
// ===================== Máquina principal =====================
class GBA {
  constructor() {
    this.io = new IO(this);
    this.bus = new Bus(this);
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.apu = new APU(this);
    this.dma = new DMA(this);
    this.timers = new Timers(this);
    this.hle = new HLE(this);
    this.save = new SaveMemory('none');
    this.rtc = new GpioRtc();
    this.irqLine = false;
    this.dmaCycles = 0;
    this.carry = 0;
    this.frameCount = 0;
    this.romLoaded = false;
    this.title = ''; this.code = '';
    this.log = null;
  }

  // Carrega o jogo: lê o título e o código do cabeçalho (0xA0 e 0xAC), descobre o tipo de save e reinicia.
  loadRom(bytes) {
    this.bus.loadRom(bytes);
    const hdr = (a, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = bytes[a + i]; if (c >= 32 && c < 127) s += String.fromCharCode(c); } return s.trim(); };
    this.title = hdr(0xA0, 12); this.code = hdr(0xAC, 4);
    const type = detectSaveType(bytes);
    this.save = new SaveMemory(type);
    this.bus.eepromMode = type === 'eeprom';
    this.bus.gpio = this.rtc;
    this.romLoaded = true;
    this.reset();
  }

  reset() {
    this.io.reset(); this.cpu.reset(); this.ppu.reset(); this.apu.reset(); this.dma.reset(); this.timers.reset();
    this.bus.ewram.fill(0); this.bus.iwram.fill(0); this.bus.pal.fill(0); this.bus.vram.fill(0); this.bus.oam.fill(0);
    this.bus.updateWaitstates(0);
    this.rtc.state = 0; this.rtc.readable = 0;
    this.irqLine = false; this.dmaCycles = 0; this.carry = 0;
  }

  // irqLine = existe interrupção pedida (IF), habilitada (IE) e com a chave geral (IME) ligada?
  updateIrq() {
    const regs = this.io.regs;
    this.irqLine = (regs[0x104] & 1) !== 0 && (regs[0x100] & regs[0x101] & 0x3FFF) !== 0;
  }
  // Um componente (tela, timer, DMA...) pede uma interrupção ligando um bit de IF.
  requestIrq(mask) {
    this.io.regs[0x101] |= mask;
    this.updateIrq();
  }

  // Cabo de link: não há outro GBA conectado, então a transferência termina na hora devolvendo 0xFFFF ("ninguém").
  serialWrite(v) {
    if (!(v & 0x80)) return;
    const regs = this.io.regs;
    const mode = (v >>> 12) & 3;
    if (mode === 2) { // multiplayer: ninguém conectado
      regs[0x120 >> 1] = 0xFFFF; regs[0x122 >> 1] = 0xFFFF; regs[0x124 >> 1] = 0xFFFF; regs[0x126 >> 1] = 0xFFFF;
    } else if (!(v & 1)) return; // clock externo: nunca completa
    else { regs[0x120 >> 1] = 0xFFFF; regs[0x122 >> 1] = 0xFFFF; regs[0x12A >> 1] = 0xFFFF; }
    regs[0x94] = v & ~0x80;
    if (v & 0x4000) this.requestIrq(0x80);
  }

  // Atualiza os botões (bit 0 = A, 1 = B, 2 = Select, 3 = Start, 4–7 = direcional, 8 = R, 9 = L; 0 = apertado).
  setKeys(k) { this.io.keys = k & 0x3FF; this.checkKeyIrq(); }
  checkKeyIrq() {
    const cnt = this.io.regs[0x99];
    if (!(cnt & 0x4000)) return;
    const pressed = (~this.io.keys) & 0x3FF, sel = cnt & 0x3FF;
    const hit = (cnt & 0x8000) ? (pressed & sel) === sel && sel : (pressed & sel);
    if (hit) this.requestIrq(0x1000);
  }

  // Roda a CPU por uma quantidade de ciclos. Se o processador está dormindo (HALT),
  // só o tempo passa (timers e som) até chegar uma interrupção.
  // Devolve a "sobra" (número negativo) para compensar no próximo trecho.
  run(cycles) {
    const cpu = this.cpu, timers = this.timers, apu = this.apu, regs = this.io.regs;
    let left = cycles;
    while (left > 0) {
      if (cpu.halted) {
        if (regs[0x100] & regs[0x101] & 0x3FFF) cpu.halted = false;
        else {
          const c = left < 64 ? left : 64;
          if (timers.active) timers.tick(c);
          apu.tick(c);
          left -= c;
          if (this.dmaCycles) { left -= this.dmaCycles; this.dmaCycles = 0; }
          continue;
        }
      }
      if (this.irqLine && !cpu.I) cpu.irq();
      let c = cpu.step();
      if (this.dmaCycles) { c += this.dmaCycles; this.dmaCycles = 0; }
      left -= c;
      if (timers.active) { timers.pend += c; if (timers.pend >= timers.until) timers.flush(); }
      apu.cyc += c; if (apu.cyc >= 512) apu.tick(0);
    }
    return left;
  }

  // Roda um quadro inteiro, linha por linha, gerando os eventos na ordem do hardware:
  // comparação de linha (VCount), VBlank na linha 160, desenho no fim do HDraw e HBlank.
  // render = false pula só o desenho (usado no acelerar para quadros que não serão mostrados);
  // o jogo roda igual, porque nada do jogo depende da imagem final.
  runFrame(render = true) {
    const ppu = this.ppu, regs = this.io.regs, dma = this.dma;
    for (let line = 0; line < 228; line++) {
      ppu.vcount = line;
      const dispstat = regs[2];
      if (line === (dispstat >>> 8)) { ppu.stat |= 4; if (dispstat & 0x20) this.requestIrq(4); }
      else ppu.stat &= ~4;
      if (line === 160) {
        ppu.stat |= 1;
        if (dispstat & 8) this.requestIrq(1);
        dma.trigger(1);
        ppu.loadRef(0); ppu.loadRef(1);
      } else if (line === 227) ppu.stat &= ~1;
      this.carry = this.run(960 + this.carry);
      if (line < 160) { if (render) ppu.renderLine(line); ppu.stepRefs(); }
      ppu.stat |= 2;
      if (regs[2] & 0x10) this.requestIrq(2);
      if (line < 160) dma.trigger(2);
      this.carry = this.run(272 + this.carry);
      ppu.stat &= ~2;
    }
    this.frameCount++;
  }

  // ---------- save states ----------
  // Save states: snap() fotografa os campos de um componente (números e arrays),
  // ignorando referências a outros objetos e as visões de 16/32 bits (que são os mesmos bytes).
  static snap(obj, skip) {
    const o = {};
    for (const k of Object.keys(obj)) {
      if (skip && skip.has(k)) continue;
      const v = obj[k];
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') o[k] = v;
      else if (ArrayBuffer.isView(v)) { if (!/(16|32)$/.test(k)) o[k] = v.slice(); }
      else if (Array.isArray(v)) o[k] = v.map(x => ArrayBuffer.isView(x) ? x.slice() : (x && typeof x === 'object') ? GBA.snap(x) : x);
      else if (v && typeof v === 'object' && v.constructor === Object) o[k] = GBA.snap(v);
    }
    return o;
  }
  // restore() devolve os valores para dentro dos arrays existentes, mantendo as visões ligadas aos mesmos bytes.
  static restore(obj, o) {
    for (const k of Object.keys(o)) {
      const cur = obj[k], v = o[k];
      if (ArrayBuffer.isView(cur)) { if (cur.length === v.length) cur.set(v); }
      else if (Array.isArray(cur) && !(v.length && (ArrayBuffer.isView(v[0]) || typeof v[0] === 'object'))) obj[k] = v.slice();
      else if (Array.isArray(cur)) {
        for (let i = 0; i < v.length; i++) {
          if (ArrayBuffer.isView(cur[i])) cur[i].set(v[i]);
          else if (cur[i] && typeof cur[i] === 'object') GBA.restore(cur[i], v[i]);
          else cur[i] = v[i];
        }
      } else if (cur && typeof cur === 'object' && cur.constructor === Object) GBA.restore(cur, v);
      else obj[k] = v;
    }
  }
  // Estado completo da máquina, sem a ROM (que já está carregada) e sem o save da bateria.
  saveState() {
    return {
      v: 1, code: this.code,
      gba: GBA.snap(this, new Set(['title', 'code', 'romLoaded', 'log'])),
      bus: GBA.snap(this.bus, new Set(['rom', 'romSize', 'bios', 'realBios'])),
      io: GBA.snap(this.io), cpu: GBA.snap(this.cpu), ppu: GBA.snap(this.ppu, new Set(['frame', 'lut', 'frameBuf'])),
      apu: GBA.snap(this.apu, new Set(['regs'])), dma: GBA.snap(this.dma), timers: GBA.snap(this.timers),
      save: GBA.snap(this.save, new Set(['data', 'type'])), rtc: GBA.snap(this.rtc),
    };
  }
  loadState(s) {
    GBA.restore(this, s.gba);
    GBA.restore(this.bus, s.bus); GBA.restore(this.io, s.io); GBA.restore(this.cpu, s.cpu); GBA.restore(this.ppu, s.ppu);
    GBA.restore(this.apu, s.apu); GBA.restore(this.dma, s.dma); GBA.restore(this.timers, s.timers);
    GBA.restore(this.save, s.save); GBA.restore(this.rtc, s.rtc);
    this.bus.updateWaitstates(this.io.regs[0x102]);
    this.updateIrq();
  }
}

if (typeof module !== 'undefined') module.exports = { GBA };
