'use strict';
// =====================================================================
// apu.js — O SOM (APU)
// =====================================================================
// O GBA tem dois tipos de som, misturados aqui:
//   • Direct Sound A e B: som digital (amostras de 8 bits). O jogo enche
//     uma fila (FIFO) de 32 bytes via DMA; a cada estouro do timer 0 ou 1
//     sai a próxima amostra. É por aqui que vem a música dos Pokémon.
//   • 4 canais "PSG" herdados do Game Boy: 2 ondas quadradas (o canal 1
//     tem sweep, que muda o tom sozinho), 1 onda programável e 1 ruído.
//     Cada um tem envelope (volume que sobe ou desce) e duração.
// Geramos 32.768 amostras por segundo (1 a cada 512 ciclos) e as
// entregamos à interface por out(l, r).
// =====================================================================
// ===================== Som (APU): PSG + Direct Sound =====================
// Proporção do tempo em que a onda quadrada fica "alta": 12,5%, 25%, 50% ou 75% (muda o timbre).
const DUTY = [0.125, 0.25, 0.5, 0.75];
class APU {
  constructor(gba) {
    this.gba = gba;
    this.regs = gba.io.regs;
    this.fifo = [new Int8Array(32), new Int8Array(32)];
    this.fifoR = new Uint8Array(2); this.fifoW = new Uint8Array(2); this.fifoN = new Uint8Array(2);
    this.fifoS = new Int32Array(2);
    this.wave = new Uint8Array(32);
    this.cyc = 0; this.seqCount = 0; this.seqStep = 0;
    this.on = new Uint8Array(4); this.len = new Uint16Array(4); this.vol = new Uint8Array(4);
    this.envTimer = new Uint8Array(4); this.phase = new Float64Array(4);
    this.shadow = 0; this.sweepTimer = 0; this.lfsr = 0x7FFF;
    this.out = null; // callback(l, r)
  }
  reset() {
    for (const f of this.fifo) f.fill(0);
    this.fifoR.fill(0); this.fifoW.fill(0); this.fifoN.fill(0); this.fifoS.fill(0);
    this.wave.fill(0); this.on.fill(0); this.len.fill(0); this.vol.fill(0); this.envTimer.fill(0); this.phase.fill(0);
    this.cyc = 0; this.seqCount = 0; this.seqStep = 0;
  }
  status() { return this.on[0] | (this.on[1] << 1) | (this.on[2] << 2) | (this.on[3] << 3); }

  readWave(o) {
    const bank = (this.regs[0x38] & 0x40) ? 0 : 16;
    const i = bank + (o - 0x90);
    return this.wave[i] | (this.wave[i + 1] << 8);
  }

  // Escritas nos registradores de som. Algumas "disparam" (trigger) uma nota quando o bit 15 é 1.
  write(o, v) {
    const regs = this.regs;
    if (o >= 0x90 && o < 0xA0) {
      const bank = (regs[0x38] & 0x40) ? 0 : 16;
      const i = bank + (o - 0x90);
      this.wave[i] = v & 0xFF; this.wave[i + 1] = v >>> 8;
      return;
    }
    if (!(regs[0x42] & 0x80) && o < 0x80) return; // som desligado: PSG ignora escrita
    switch (o) {
      case 0x62: regs[o >> 1] = v; this.len[0] = 64 - (v & 63); return;
      case 0x68: regs[o >> 1] = v; this.len[1] = 64 - (v & 63); return;
      case 0x72: regs[o >> 1] = v; this.len[2] = 256 - (v & 0xFF); return;
      case 0x78: regs[o >> 1] = v; this.len[3] = 64 - (v & 63); return;
      case 0x64: regs[o >> 1] = v & 0x47FF; if (v & 0x8000) this.trigger(0); return;
      case 0x6C: regs[o >> 1] = v & 0x47FF; if (v & 0x8000) this.trigger(1); return;
      case 0x74: regs[o >> 1] = v & 0x47FF; if (v & 0x8000) this.trigger(2); return;
      case 0x7C: regs[o >> 1] = v & 0x40FF; if (v & 0x8000) this.trigger(3); return;
      case 0x70: regs[o >> 1] = v & 0xE0; if (!(v & 0x80)) this.on[2] = 0; return;
      case 0x82:
        if (v & 0x0800) { this.fifoR[0] = this.fifoW[0] = this.fifoN[0] = 0; }
        if (v & 0x8000) { this.fifoR[1] = this.fifoW[1] = this.fifoN[1] = 0; }
        regs[o >> 1] = v & 0x770F; return;
      case 0x84:
        regs[o >> 1] = (regs[o >> 1] & 0x0F) | (v & 0x80);
        if (!(v & 0x80)) { this.on.fill(0); for (let a = 0x60; a < 0x82; a += 2) regs[a >> 1] = 0; }
        return;
    }
    regs[o >> 1] = v;
  }

  // Começa uma nota no canal i: liga o canal, recarrega a duração, o volume inicial e o sweep.
  trigger(i) {
    const regs = this.regs;
    this.on[i] = 1;
    if (this.len[i] === 0) this.len[i] = i === 2 ? 256 : 64;
    this.phase[i] = 0;
    if (i !== 2) {
      const env = regs[[0x31, 0x34, 0, 0x3C][i]];
      this.vol[i] = env >>> 12;
      this.envTimer[i] = (env >>> 8) & 7;
      if ((env & 0xF800) === 0) this.on[i] = 0; // DAC desligado
    } else if (!(regs[0x38] & 0x80)) this.on[2] = 0;
    if (i === 0) {
      this.shadow = regs[0x32] & 0x7FF;
      const sw = regs[0x30];
      this.sweepTimer = ((sw >>> 4) & 7) || 8;
      if ((sw & 7) && this.sweepCalc() > 2047) this.on[0] = 0;
    }
    if (i === 3) this.lfsr = (regs[0x3E] & 8) ? 0x7F : 0x7FFF;
  }
  sweepCalc() {
    const sw = this.regs[0x30], d = this.shadow >> (sw & 7);
    return (sw & 8) ? this.shadow - d : this.shadow + d;
  }

  // Coloca um byte (amostra) na fila do Direct Sound A (i=0) ou B (i=1).
  fifoPush(i, b) {
    if (this.fifoN[i] >= 32) return;
    this.fifo[i][this.fifoW[i]] = b;
    this.fifoW[i] = (this.fifoW[i] + 1) & 31; this.fifoN[i]++;
  }
  // Timer t estourou: cada fila ligada a ele entrega a próxima amostra e, se estiver quase vazia, pede mais ao DMA.
  timerOverflow(t) {
    const cntH = this.regs[0x41];
    for (let i = 0; i < 2; i++) {
      if (((cntH >>> (i ? 14 : 10)) & 1) !== t) continue;
      if (this.fifoN[i] > 0) {
        this.fifoS[i] = this.fifo[i][this.fifoR[i]];
        this.fifoR[i] = (this.fifoR[i] + 1) & 31; this.fifoN[i]--;
      }
      if (this.fifoN[i] <= 16) this.gba.dma.fifoRequest(i ? 0x040000A4 : 0x040000A0);
    }
  }

  // Avança o tempo do som; a cada 512 ciclos gera uma amostra.
  tick(c) {
    this.cyc += c;
    while (this.cyc >= 512) { this.cyc -= 512; this.sample(); }
  }

  // Sequenciador a 512 Hz: duração das notas (256 Hz), sweep (128 Hz) e envelope de volume (64 Hz).
  frameSeq() {
    const regs = this.regs, s = this.seqStep;
    this.seqStep = (s + 1) & 7;
    if (!(s & 1)) { // comprimento 256 Hz
      const lenEn = [regs[0x32] & 0x4000, regs[0x36] & 0x4000, regs[0x3A] & 0x4000, regs[0x3E] & 0x4000];
      for (let i = 0; i < 4; i++) if (lenEn[i] && this.len[i] > 0) { if (--this.len[i] === 0) this.on[i] = 0; }
    }
    if (s === 2 || s === 6) { // sweep 128 Hz
      const sw = regs[0x30], t = (sw >>> 4) & 7;
      if (this.on[0] && t) {
        if (--this.sweepTimer <= 0) {
          this.sweepTimer = t;
          const nf = this.sweepCalc();
          if (nf > 2047) this.on[0] = 0;
          else if (sw & 7) { this.shadow = nf; regs[0x32] = (regs[0x32] & ~0x7FF) | nf; }
        }
      }
    }
    if (s === 7) { // envelope 64 Hz
      const envs = [regs[0x31], regs[0x34], 0, regs[0x3C]];
      for (let i = 0; i < 4; i++) {
        if (i === 2) continue;
        const p = (envs[i] >>> 8) & 7;
        if (!p) continue;
        if (this.envTimer[i] > 0) this.envTimer[i]--;
        if (this.envTimer[i] === 0) {
          this.envTimer[i] = p;
          if (envs[i] & 0x800) { if (this.vol[i] < 15) this.vol[i]++; }
          else if (this.vol[i] > 0) this.vol[i]--;
        }
      }
    }
  }

  // Gera uma amostra estéreo: calcula cada canal PSG (fase da onda × volume),
  // aplica os volumes mestre e soma o Direct Sound. O resultado fica entre -1 e 1.
  sample() {
    if (++this.seqCount >= 64) { this.seqCount = 0; this.frameSeq(); }
    const regs = this.regs;
    const cntL = regs[0x40], cntH = regs[0x41], cntX = regs[0x42];
    if (!(cntX & 0x80)) { if (this.out) this.out(0, 0); return; }
    let l = 0, r = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.on[i]) continue;
      let v = 0;
      if (i < 2) {
        const f = regs[i ? 0x36 : 0x32] & 0x7FF;
        const duty = DUTY[(regs[i ? 0x34 : 0x31] >>> 6) & 3];
        let ph = this.phase[i] + 4 / (2048 - f);
        ph -= Math.floor(ph);
        this.phase[i] = ph;
        v = (ph < duty ? 1 : -1) * this.vol[i];
      } else if (i === 2) {
        const c3 = regs[0x38], f = regs[0x3A] & 0x7FF;
        const n = (c3 & 0x20) ? 64 : 32;
        let ph = this.phase[2] + 64 / (2048 - f);
        if (ph >= n) ph -= n * Math.floor(ph / n);
        this.phase[2] = ph;
        const idx = ph | 0;
        const playBank = (c3 >>> 6) & 1;
        const bank = (c3 & 0x20) ? ((playBank + (idx >> 5)) & 1) : playBank;
        const byte = this.wave[bank * 16 + ((idx & 31) >> 1)];
        const s = (idx & 1) ? byte & 15 : byte >> 4;
        const vc = regs[0x39];
        const vf = (vc & 0x8000) ? 0.75 : [0, 1, 0.5, 0.25][(vc >>> 13) & 3];
        v = (s - 7.5) * 2 * vf;
      } else {
        const c = regs[0x3E];
        const div = c & 7, sh = (c >>> 4) & 15;
        const freq = 524288 / (div ? div : 0.5) / Math.pow(2, sh + 1);
        let ph = this.phase[3] + freq / 32768;
        let steps = ph | 0; ph -= steps;
        if (steps > 64) steps = 64;
        this.phase[3] = ph;
        let lf = this.lfsr;
        for (let k = 0; k < steps; k++) {
          const bit = (lf ^ (lf >> 1)) & 1;
          lf = (lf >> 1) | (bit << 14);
          if (c & 8) lf = (lf & ~0x40) | (bit << 6);
        }
        this.lfsr = lf;
        v = (lf & 1) ? -this.vol[3] : this.vol[3];
      }
      if (cntL & (0x100 << i)) r += v;
      if (cntL & (0x1000 << i)) l += v;
    }
    const ps = [0.25, 0.5, 1, 0][cntH & 3];
    l *= (((cntL >>> 4) & 7) + 1) * ps;
    r *= ((cntL & 7) + 1) * ps;
    const a = this.fifoS[0] * ((cntH & 4) ? 4 : 2), b = this.fifoS[1] * ((cntH & 8) ? 4 : 2);
    if (cntH & 0x100) r += a; if (cntH & 0x200) l += a;
    if (cntH & 0x1000) r += b; if (cntH & 0x2000) l += b;
    if (this.out) this.out(l / 1536, r / 1536);
  }
}
