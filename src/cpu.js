'use strict';
// =====================================================================
// cpu.js — O PROCESSADOR (ARM7TDMI)
// =====================================================================
// O GBA usa um processador ARM7TDMI de 16,78 MHz. Este arquivo imita
// esse chip: lê uma instrução da memória, descobre o que ela faz e executa.
//
// Ele entende DOIS "idiomas" de instrução:
//   • ARM   — instruções de 32 bits, mais poderosas
//   • Thumb — instruções de 16 bits, mais compactas (a maioria dos jogos usa)
// O bit T do registrador de estado diz qual idioma está ativo.
//
// Conceitos usados aqui:
//   • Registradores: 16 "gavetas" de 32 bits (r0..r15). r13 = pilha (SP),
//     r14 = endereço de retorno (LR), r15 = endereço da instrução (PC).
//   • Flags N, Z, C, V: indicadores do resultado da última conta
//     (Negativo, Zero, Carry/vai-um, oVerflow/estouro). Instruções
//     condicionais olham essas flags para decidir se executam.
//   • Modos: o processador tem modos (usuário, sistema, interrupção...).
//     Alguns registradores (r13, r14, e no modo FIQ r8..r14) têm cópias
//     próprias em cada modo — os "bancos".
// =====================================================================
// ===================== CPU ARM7TDMI =====================
// Códigos dos modos do processador (os 5 bits baixos do registrador de estado CPSR).
const MODE_USR = 0x10, MODE_FIQ = 0x11, MODE_IRQ = 0x12, MODE_SVC = 0x13, MODE_ABT = 0x17, MODE_UND = 0x1B, MODE_SYS = 0x1F;
// Converte o modo no índice do banco de registradores que ele usa (usr e sys compartilham o banco 0).
function bankOf(m) {
  switch (m) { case 0x11: return 1; case 0x12: return 2; case 0x13: return 3; case 0x17: return 4; case 0x1B: return 5; default: return 0; }
}
// Conta quantos bits estão ligados: diz quantos registradores um LDM/STM/PUSH/POP vai mover.
function popcount16(x) { x = x - ((x >>> 1) & 0x5555); x = (x & 0x3333) + ((x >>> 2) & 0x3333); x = (x + (x >>> 4)) & 0x0F0F; return (x + (x >>> 8)) & 0x1F; }

class CPU {
  // Estado do processador. Uint32Array guarda números de 32 bits sem sinal,
  // igual ao hardware: somar e passar de 0xFFFFFFFF "dá a volta" sozinho.
  constructor(gba) {
    this.gba = gba;
    this.bus = gba.bus;
    this.r = new Uint32Array(16);
    this.bankR13 = new Uint32Array(6);
    this.bankR14 = new Uint32Array(6);
    this.usrR8 = new Uint32Array(5);
    this.fiqR8 = new Uint32Array(5);
    this.spsr = new Uint32Array(6);
    this.N = 0; this.Z = 0; this.C = 0; this.V = 0; this.I = 0; this.F = 0; this.T = 0;
    this.mode = MODE_SYS;
    this.sc = 0;          // shifter carry out
    this.branched = false;
    this.halted = false;
    this.intrWaitActive = false;
    this.extra = 0;
  }

  // Estado logo depois que a BIOS original termina a animação de abertura:
  // pilhas já configuradas e PC no início do cartucho (0x08000000).
  reset() {
    this.r.fill(0); this.bankR13.fill(0); this.bankR14.fill(0); this.usrR8.fill(0); this.fiqR8.fill(0); this.spsr.fill(0);
    this.N = this.Z = this.C = this.V = 0; this.I = 0; this.F = 0; this.T = 0;
    this.mode = MODE_SYS;
    this.bankR13[bankOf(MODE_SVC)] = 0x03007FE0;
    this.bankR13[bankOf(MODE_IRQ)] = 0x03007FA0;
    this.r[13] = 0x03007F00;
    this.r[15] = 0x08000000;
    this.halted = false; this.intrWaitActive = false;
  }

  // Monta o registrador de estado (CPSR) a partir das flags e do modo, que ficam separados para ser mais rápido.
  getCPSR() {
    return ((this.N << 31) | (this.Z << 30) | (this.C << 29) | (this.V << 28) | (this.I << 7) | (this.F << 6) | (this.T << 5) | this.mode) >>> 0;
  }
  // Faz o caminho inverso: separa um CPSR em flags e modo (trocando o banco de registradores se o modo mudou).
  setCPSR(v) {
    this.switchMode((v & 0x1F) | 0x10);
    this.N = (v >>> 31) & 1; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1;
    this.I = (v >>> 7) & 1; this.F = (v >>> 6) & 1; this.T = (v >>> 5) & 1;
  }
  getSPSR() { const b = bankOf(this.mode); return b ? this.spsr[b] : this.getCPSR(); }

  // Troca de modo: guarda r13/r14 (e r8–r12 no modo FIQ) do modo antigo
  // e carrega as cópias do modo novo.
  switchMode(m) {
    const ob = bankOf(this.mode), nb = bankOf(m), r = this.r;
    if (ob !== nb) {
      this.bankR13[ob] = r[13]; this.bankR14[ob] = r[14];
      if (ob === 1) { for (let i = 0; i < 5; i++) { this.fiqR8[i] = r[8 + i]; r[8 + i] = this.usrR8[i]; } }
      if (nb === 1) { for (let i = 0; i < 5; i++) { this.usrR8[i] = r[8 + i]; r[8 + i] = this.fiqR8[i]; } }
      r[13] = this.bankR13[nb]; r[14] = this.bankR14[nb];
    }
    this.mode = m;
  }

  // Atende uma interrupção (fim de quadro, timer, DMA...): salva o estado,
  // entra no modo IRQ e pula para 0x18, onde está o tratador da BIOS.
  // Ao terminar, o jogo volta exatamente para onde estava.
  irq() {
    const cpsr = this.getCPSR();
    this.switchMode(MODE_IRQ);
    this.spsr[2] = cpsr;
    this.r[14] = (this.r[15] + 4) >>> 0;
    this.T = 0; this.I = 1;
    this.r[15] = 0x18;
    this.halted = false;
  }

  setPC(v) { this.r[15] = this.T ? (v & ~1) : (v & ~3); this.branched = true; }

  // Toda instrução ARM tem 4 bits de condição (EQ = "se igual", NE = "se diferente"...).
  // Esta função diz se a condição é verdadeira olhando as flags.
  cond(c) {
    switch (c) {
      case 0: return this.Z === 1;
      case 1: return this.Z === 0;
      case 2: return this.C === 1;
      case 3: return this.C === 0;
      case 4: return this.N === 1;
      case 5: return this.N === 0;
      case 6: return this.V === 1;
      case 7: return this.V === 0;
      case 8: return this.C === 1 && this.Z === 0;
      case 9: return this.C === 0 || this.Z === 1;
      case 10: return this.N === this.V;
      case 11: return this.N !== this.V;
      case 12: return this.Z === 0 && this.N === this.V;
      case 13: return this.Z === 1 || this.N !== this.V;
      case 14: return true;
      default: return false;
    }
  }

  // returns cycles used
  // Executa UMA instrução e devolve quantos ciclos ela levou.
  // Durante a execução, r15 vale "endereço atual + 8" (ARM) ou "+ 4" (Thumb),
  // como no hardware real, por causa do pipeline. Se a instrução não pulou
  // para outro lugar (branched), avançamos para a próxima.
  step() {
    const r = this.r, bus = this.bus;
    const pc = r[15];
    this.branched = false;
    this.extra = 0;
    const reg = (pc >>> 24) & 15;
    if (this.T) {
      const op = bus.read16(pc);
      r[15] = pc + 4;
      this.execThumb(op, pc);
      if (!this.branched) r[15] = pc + 2; else this.extra += 2;
      return bus.fetch16[reg] + this.extra;
    } else {
      const op = bus.read32(pc);
      if (reg === 0) bus.biosLast = op;
      r[15] = pc + 8;
      if (this.cond(op >>> 28)) this.execArm(op, pc);
      if (!this.branched) r[15] = pc + 4; else this.extra += 2;
      return bus.fetch32[reg] + this.extra;
    }
  }

  // O "barrel shifter": muitas instruções deslocam ou giram um operando antes de usar.
  // LSL = desloca à esquerda, LSR = à direita, ASR = à direita mantendo o sinal,
  // ROR = gira. Os casos com 0 e 32 têm regras especiais do hardware; this.sc guarda
  // o bit que "caiu para fora" (vira a flag C nas instruções lógicas).
  // ---------------- shifter ----------------
  shiftImm(type, m, s) {
    switch (type) {
      case 0:
        if (s === 0) { this.sc = this.C; return m; }
        this.sc = (m >>> (32 - s)) & 1; return (m << s) >>> 0;
      case 1:
        if (s === 0) { this.sc = m >>> 31; return 0; }
        this.sc = (m >>> (s - 1)) & 1; return m >>> s;
      case 2:
        if (s === 0) { this.sc = m >>> 31; return (m >> 31) >>> 0; }
        this.sc = (m >> (s - 1)) & 1; return (m >> s) >>> 0;
      default:
        if (s === 0) { this.sc = m & 1; return ((this.C << 31) | (m >>> 1)) >>> 0; }
        this.sc = (m >>> (s - 1)) & 1; return ((m >>> s) | (m << (32 - s))) >>> 0;
    }
  }
  shiftReg(type, m, s) {
    if (s === 0) { this.sc = this.C; return m; }
    switch (type) {
      case 0:
        if (s < 32) { this.sc = (m >>> (32 - s)) & 1; return (m << s) >>> 0; }
        this.sc = s === 32 ? (m & 1) : 0; return 0;
      case 1:
        if (s < 32) { this.sc = (m >>> (s - 1)) & 1; return m >>> s; }
        this.sc = s === 32 ? (m >>> 31) : 0; return 0;
      case 2:
        if (s < 32) { this.sc = (m >> (s - 1)) & 1; return (m >> s) >>> 0; }
        this.sc = m >>> 31; return (m >> 31) >>> 0;
      default: {
        const t = s & 31;
        if (t === 0) { this.sc = m >>> 31; return m; }
        this.sc = (m >>> (t - 1)) & 1; return ((m >>> t) | (m << (32 - t))) >>> 0;
      }
    }
  }

  // Contas que também calculam as flags. Exemplo: em a + b, C = 1 se o resultado
  // passou de 32 bits; V = 1 se dois positivos deram negativo (ou vice-versa).
  // ---------------- flag helpers ----------------
  addF(a, b) {
    const t = a + b, res = t >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = t > 0xFFFFFFFF ? 1 : 0;
    this.V = ((a ^ res) & (b ^ res)) >>> 31; return res;
  }
  adcF(a, b) {
    const t = a + b + this.C, res = t >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = t > 0xFFFFFFFF ? 1 : 0;
    this.V = ((a ^ res) & (b ^ res)) >>> 31; return res;
  }
  subF(a, b) {
    const res = (a - b) >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = a >= b ? 1 : 0;
    this.V = ((a ^ b) & (a ^ res)) >>> 31; return res;
  }
  sbcF(a, b) {
    const t = a - b - (1 - this.C), res = t >>> 0;
    this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = t >= 0 ? 1 : 0;
    this.V = ((a ^ b) & (a ^ res)) >>> 31; return res;
  }
  // Lê uma palavra de 32 bits. Se o endereço não for múltiplo de 4, o ARM7 gira o valor (comportamento real que alguns jogos usam).
  ldrWord(addr) {
    const v = this.bus.read32(addr & ~3);
    const s = (addr & 3) << 3;
    return s ? ((v >>> s) | (v << (32 - s))) >>> 0 : v;
  }

  // ---------------------------------------------------------------------
  // Instruções ARM (32 bits). Os bits 25–27 separam as famílias:
  // 000/001 = contas (ADD, SUB, MOV...), 010/011 = ler/gravar memória,
  // 100 = ler/gravar vários registradores, 101 = desvio (B, BL), 111 = SWI.
  // ---------------------------------------------------------------------
  // ================= ARM =================
  execArm(op, pc) {
    const r = this.r;
    switch ((op >>> 25) & 7) {
      case 0:
        if ((op & 0x0FFFFFF0) === 0x012FFF10) { // BX
          const v = r[op & 15];
          if (v & 1) { this.T = 1; r[15] = v & ~1; } else r[15] = v & ~3;
          this.branched = true; return;
        }
        if ((op & 0x90) === 0x90) {
          if ((op & 0x60) === 0) {
            if (op & 0x01000000) this.armSwap(op);
            else if (op & 0x00800000) this.armMulLong(op);
            else this.armMul(op);
          } else this.armHalf(op);
          return;
        }
        this.armData(op, false); return;
      case 1: this.armData(op, true); return;
      case 2: this.armSDT(op, false); return;
      case 3: if (!(op & 0x10)) this.armSDT(op, true); return;
      case 4: this.armBlock(op); return;
      case 5: {
        const off = (op << 8) >> 6;
        if (op & 0x01000000) r[14] = pc + 4;
        r[15] = (r[15] + off) >>> 0; this.branched = true; return;
      }
      case 6: return;
      case 7:
        if ((op & 0x0F000000) === 0x0F000000) this.swi((op >>> 16) & 0xFF, pc);
        return;
    }
  }

  // Instruções de processamento de dados: AND, EOR, SUB, RSB, ADD, ADC, SBC, RSC,
  // TST, TEQ, CMP, CMN, ORR, MOV, BIC, MVN. O segundo operando pode ser um número
  // fixo (girado) ou um registrador deslocado. Se gravar em r15 com o bit S,
  // é um "retorno de exceção": o estado anterior (SPSR) é restaurado.
  armData(op, imm) {
    const r = this.r;
    const opcode = (op >>> 21) & 15, S = (op >>> 20) & 1, rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
    if (!S && (opcode >>> 2) === 2) { this.armPSR(op, imm); return; }
    let a, b;
    if (imm) {
      const v = op & 0xFF, rot = (op >>> 7) & 0x1E;
      if (rot) { b = ((v >>> rot) | (v << (32 - rot))) >>> 0; this.sc = b >>> 31; }
      else { b = v; this.sc = this.C; }
      a = r[rn];
    } else {
      const rm = op & 15, type = (op >>> 5) & 3;
      if (op & 0x10) {
        let m = r[rm]; if (rm === 15) m = (m + 4) >>> 0;
        a = r[rn]; if (rn === 15) a = (a + 4) >>> 0;
        b = this.shiftReg(type, m, r[(op >>> 8) & 15] & 0xFF);
        this.extra++;
      } else {
        a = r[rn];
        b = this.shiftImm(type, r[rm], (op >>> 7) & 31);
      }
    }
    let res, logical = true, c = 0, v = 0;
    switch (opcode) {
      case 0: case 8: res = (a & b) >>> 0; break;
      case 1: case 9: res = (a ^ b) >>> 0; break;
      case 2: case 10: res = (a - b) >>> 0; logical = false; c = a >= b ? 1 : 0; v = ((a ^ b) & (a ^ res)) >>> 31; break;
      case 3: res = (b - a) >>> 0; logical = false; c = b >= a ? 1 : 0; v = ((b ^ a) & (b ^ res)) >>> 31; break;
      case 4: case 11: { const t = a + b; res = t >>> 0; logical = false; c = t > 0xFFFFFFFF ? 1 : 0; v = ((a ^ res) & (b ^ res)) >>> 31; break; }
      case 5: { const t = a + b + this.C; res = t >>> 0; logical = false; c = t > 0xFFFFFFFF ? 1 : 0; v = ((a ^ res) & (b ^ res)) >>> 31; break; }
      case 6: { const t = a - b - (1 - this.C); res = t >>> 0; logical = false; c = t >= 0 ? 1 : 0; v = ((a ^ b) & (a ^ res)) >>> 31; break; }
      case 7: { const t = b - a - (1 - this.C); res = t >>> 0; logical = false; c = t >= 0 ? 1 : 0; v = ((b ^ a) & (b ^ res)) >>> 31; break; }
      case 12: res = (a | b) >>> 0; break;
      case 13: res = b; break;
      case 14: res = (a & ~b) >>> 0; break;
      default: res = (~b) >>> 0; break;
    }
    const test = opcode >= 8 && opcode <= 11;
    if (S) {
      if (rd === 15 && !test) {
        this.setCPSR(this.getSPSR());
        r[15] = this.T ? (res & ~1) : (res & ~3);
        this.branched = true;
        return;
      }
      this.N = res >>> 31; this.Z = res === 0 ? 1 : 0;
      if (logical) this.C = this.sc; else { this.C = c; this.V = v; }
    }
    if (!test) {
      if (rd === 15) { r[15] = res & ~3; this.branched = true; }
      else r[rd] = res;
    }
  }

  // MRS lê e MSR grava o registrador de estado. Jogos usam para ligar e desligar interrupções.
  armPSR(op, imm) {
    const r = this.r;
    const R = (op >>> 22) & 1;
    if (!(op & 0x00200000)) { // MRS
      r[(op >>> 12) & 15] = R ? this.getSPSR() : this.getCPSR();
      return;
    }
    let v;
    if (imm) { const x = op & 0xFF, rot = (op >>> 7) & 0x1E; v = rot ? ((x >>> rot) | (x << (32 - rot))) >>> 0 : x; }
    else v = r[op & 15];
    let mask = 0;
    if (op & 0x80000) mask |= 0xFF000000;
    if (op & 0x40000) mask |= 0x00FF0000;
    if (op & 0x20000) mask |= 0x0000FF00;
    if (op & 0x10000) mask |= 0x000000FF;
    if (R) {
      const b = bankOf(this.mode);
      if (b) this.spsr[b] = ((this.spsr[b] & ~mask) | (v & mask)) >>> 0;
    } else {
      if (this.mode === MODE_USR) mask &= 0xFF000000;
      const cur = this.getCPSR();
      let nv = ((cur & ~mask) | (v & mask)) >>> 0;
      nv = (nv & ~0x20) | (cur & 0x20);
      this.setCPSR(nv);
    }
  }

  // MUL e MLA: multiplicação de 32 bits (MLA soma um terceiro valor). Math.imul dá os 32 bits baixos exatos.
  armMul(op) {
    const r = this.r;
    const rd = (op >>> 16) & 15, rn = (op >>> 12) & 15, rs = (op >>> 8) & 15, rm = op & 15;
    let res = Math.imul(r[rm], r[rs]);
    if (op & 0x200000) res = res + r[rn];
    res >>>= 0;
    r[rd] = res;
    if (op & 0x100000) { this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; }
    this.extra += 2;
  }

  // UMULL/SMULL/UMLAL/SMLAL: multiplicação com resultado de 64 bits.
  // O JavaScript não tem inteiros de 64 bits rápidos, então o número é quebrado
  // em pedaços de 16 bits e montado à mão (parte alta + parte baixa).
  armMulLong(op) {
    const r = this.r;
    const rdHi = (op >>> 16) & 15, rdLo = (op >>> 12) & 15, rs = (op >>> 8) & 15, rm = op & 15;
    const a = r[rm], b = r[rs];
    let lo = Math.imul(a, b) >>> 0;
    const aL = a & 0xFFFF, aH = a >>> 16, bL = b & 0xFFFF, bH = b >>> 16;
    const ll = aL * bL, lh = aL * bH, hl = aH * bL, hh = aH * bH;
    const mid = (ll >>> 16) + (lh & 0xFFFF) + (hl & 0xFFFF);
    let hi = hh + Math.floor(lh / 65536) + Math.floor(hl / 65536) + Math.floor(mid / 65536);
    if (op & 0x400000) { // signed
      if (a & 0x80000000) hi -= b;
      if (b & 0x80000000) hi -= a;
    }
    hi >>>= 0;
    if (op & 0x200000) {
      const l = lo + r[rdLo];
      lo = l >>> 0;
      hi = (hi + r[rdHi] + (l > 0xFFFFFFFF ? 1 : 0)) >>> 0;
    }
    r[rdLo] = lo; r[rdHi] = hi;
    if (op & 0x100000) { this.N = hi >>> 31; this.Z = (hi | lo) === 0 ? 1 : 0; }
    this.extra += 3;
  }

  // SWP: troca um valor da memória com um registrador numa única operação.
  armSwap(op) {
    const r = this.r, bus = this.bus;
    const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15, rm = op & 15;
    const addr = r[rn];
    if (op & 0x400000) {
      const t = bus.read8(addr); bus.write8(addr, r[rm] & 0xFF); r[rd] = t;
    } else {
      const t = this.ldrWord(addr); bus.write32(addr & ~3, r[rm]); r[rd] = t;
    }
    this.extra += 3;
  }

  // LDRH/STRH/LDRSB/LDRSH: ler e gravar meias-palavras (16 bits) e bytes com sinal.
  armHalf(op) {
    const r = this.r, bus = this.bus;
    const P = op & 0x1000000, U = op & 0x800000, I = op & 0x400000, W = op & 0x200000, L = op & 0x100000;
    const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15, sh = (op >>> 5) & 3;
    const off = I ? (((op >>> 4) & 0xF0) | (op & 0xF)) : r[op & 15];
    const base = r[rn];
    const addr2 = U ? (base + off) >>> 0 : (base - off) >>> 0;
    const addr = P ? addr2 : base;
    this.extra += bus.waitN16[(addr >>> 24) & 15];
    if (L) {
      let v;
      if (sh === 1) { v = bus.read16(addr & ~1); if (addr & 1) v = ((v >>> 8) | (v << 24)) >>> 0; }
      else if (sh === 2) v = ((bus.read8(addr) << 24) >> 24) >>> 0;
      else if (addr & 1) v = ((bus.read8(addr) << 24) >> 24) >>> 0;
      else v = ((bus.read16(addr) << 16) >> 16) >>> 0;
      if ((!P || W) && rn !== 15) r[rn] = addr2;
      if (rd === 15) this.setPC(v); else r[rd] = v;
      this.extra++;
    } else {
      let v = r[rd]; if (rd === 15) v += 4;
      bus.write16(addr & ~1, v & 0xFFFF);
      if ((!P || W) && rn !== 15) r[rn] = addr2;
    }
  }

  // LDR/STR/LDRB/STRB: ler e gravar 32 bits ou 1 byte. O endereço é base + deslocamento,
  // calculado antes (pré) ou depois (pós) do acesso, com ou sem atualizar a base.
  armSDT(op, regOff) {
    const r = this.r, bus = this.bus;
    const P = op & 0x1000000, U = op & 0x800000, B = op & 0x400000, W = op & 0x200000, L = op & 0x100000;
    const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
    const off = regOff ? this.shiftImm((op >>> 5) & 3, r[op & 15], (op >>> 7) & 31) : (op & 0xFFF);
    const base = r[rn];
    const addr2 = U ? (base + off) >>> 0 : (base - off) >>> 0;
    const addr = P ? addr2 : base;
    if (L) {
      const v = B ? bus.read8(addr) : this.ldrWord(addr);
      this.extra += (B ? bus.waitN16 : bus.waitN32)[(addr >>> 24) & 15] + 1;
      if ((!P || W) && rn !== 15) r[rn] = addr2;
      if (rd === 15) this.setPC(v); else r[rd] = v;
    } else {
      let v = r[rd]; if (rd === 15) v = (v + 4) >>> 0;
      this.extra += (B ? bus.waitN16 : bus.waitN32)[(addr >>> 24) & 15];
      if (B) bus.write8(addr, v & 0xFF); else bus.write32(addr & ~3, v);
      if ((!P || W) && rn !== 15) r[rn] = addr2;
    }
  }

  // LDM/STM: lê ou grava vários registradores de uma vez (usado para salvar contexto e copiar memória).
  // Inclui os detalhes estranhos do ARM7, como lista vazia e a base dentro da lista.
  armBlock(op) {
    const r = this.r, bus = this.bus;
    const P = (op >>> 24) & 1, U = (op >>> 23) & 1, S = (op >>> 22) & 1, W = (op >>> 21) & 1, L = (op >>> 20) & 1;
    const rn = (op >>> 16) & 15;
    let list = op & 0xFFFF, n, bytes;
    const base = r[rn];
    if (list === 0) { list = 0x8000; bytes = 0x40; n = 1; } else { n = popcount16(list); bytes = n * 4; }
    let addr;
    if (U) addr = P ? base + 4 : base; else addr = P ? base - bytes : base - bytes + 4;
    addr >>>= 0;
    const wb = U ? (base + bytes) >>> 0 : (base - bytes) >>> 0;
    const userBank = S && !(L && (list & 0x8000));
    const oldMode = this.mode;
    if (userBank) this.switchMode(MODE_SYS);
    this.extra += n * bus.waitN32[(addr >>> 24) & 15];
    if (L) {
      if (W) r[rn] = wb;
      for (let i = 0; i < 15; i++) {
        if (list & (1 << i)) { r[i] = bus.read32(addr & ~3); addr += 4; }
      }
      if (list & 0x8000) {
        const v = bus.read32(addr & ~3);
        if (S) this.setCPSR(this.getSPSR());
        r[15] = this.T ? (v & ~1) : (v & ~3);
        this.branched = true;
      }
      this.extra++;
    } else {
      let first = true;
      for (let i = 0; i < 16; i++) {
        if (list & (1 << i)) {
          let v;
          if (i === 15) v = (r[15] + 4) >>> 0;
          else if (i === rn) v = first ? base : wb;
          else v = r[i];
          bus.write32(addr & ~3, v); addr += 4; first = false;
        }
      }
      if (W) r[rn] = wb;
    }
    if (userBank) this.switchMode(oldMode);
  }

  // SWI = chamada à BIOS (descomprimir gráficos, dividir, esperar o próximo quadro...).
  // Com a BIOS original carregada, faz a exceção de verdade; sem ela, hle.js
  // executa a função diretamente em JavaScript.
  swi(num, pc) {
    if (this.gba.bus.realBios) {
      const cpsr = this.getCPSR();
      this.switchMode(MODE_SVC);
      this.spsr[3] = cpsr;
      this.r[14] = (pc + (this.T ? 2 : 4)) >>> 0;
      this.T = 0; this.I = 1;
      this.r[15] = 0x08; this.branched = true;
      return;
    }
    this.gba.hle.call(num, pc);
  }

  // ---------------------------------------------------------------------
  // Instruções Thumb (16 bits). Os 5 bits mais altos (op >>> 11) já dizem
  // qual dos 19 formatos é, então um único switch decodifica tudo.
  // ---------------------------------------------------------------------
  // ================= THUMB =================
  execThumb(op, pc) {
    const r = this.r, bus = this.bus;
    switch (op >>> 11) {
      case 0: case 1: case 2: {
        const rd = op & 7;
        const v = this.shiftImm(op >>> 11, r[(op >>> 3) & 7], (op >>> 6) & 31);
        r[rd] = v; this.N = v >>> 31; this.Z = v === 0 ? 1 : 0; this.C = this.sc;
        return;
      }
      case 3: {
        const rd = op & 7, a = r[(op >>> 3) & 7], x = (op >>> 6) & 7;
        const b = (op & 0x400) ? x : r[x];
        r[rd] = (op & 0x200) ? this.subF(a, b) : this.addF(a, b);
        return;
      }
      case 4: { const rd = (op >>> 8) & 7, v = op & 0xFF; r[rd] = v; this.N = 0; this.Z = v === 0 ? 1 : 0; return; }
      case 5: this.subF(r[(op >>> 8) & 7], op & 0xFF); return;
      case 6: { const rd = (op >>> 8) & 7; r[rd] = this.addF(r[rd], op & 0xFF); return; }
      case 7: { const rd = (op >>> 8) & 7; r[rd] = this.subF(r[rd], op & 0xFF); return; }
      case 8:
        if (op & 0x400) { // hi register ops / BX
          const opc = (op >>> 8) & 3;
          const rd = (op & 7) | ((op >>> 4) & 8);
          const rs = (op >>> 3) & 15;
          const b = r[rs];
          switch (opc) {
            case 0: { const v = (r[rd] + b) >>> 0; if (rd === 15) this.setPC(v); else r[rd] = v; return; }
            case 1: this.subF(r[rd], b); return;
            case 2: if (rd === 15) this.setPC(b); else r[rd] = b; return;
            default:
              if (b & 1) r[15] = b & ~1; else { this.T = 0; r[15] = b & ~3; }
              this.branched = true; return;
          }
        } else this.thumbAlu(op);
        return;
      case 9: {
        const addr = ((r[15] & ~2) + ((op & 0xFF) << 2)) >>> 0;
        r[(op >>> 8) & 7] = bus.read32(addr);
        this.extra += bus.waitN32[(addr >>> 24) & 15] + 1;
        return;
      }
      case 10: case 11: {
        const addr = (r[(op >>> 3) & 7] + r[(op >>> 6) & 7]) >>> 0, rd = op & 7;
        this.extra += bus.waitN16[(addr >>> 24) & 15] + 1;
        if (!(op & 0x200)) {
          switch ((op >>> 10) & 3) {
            case 0: bus.write32(addr & ~3, r[rd]); return;
            case 1: bus.write8(addr, r[rd] & 0xFF); return;
            case 2: r[rd] = this.ldrWord(addr); return;
            default: r[rd] = bus.read8(addr); return;
          }
        } else {
          switch ((op >>> 10) & 3) {
            case 0: bus.write16(addr & ~1, r[rd] & 0xFFFF); return;
            case 1: r[rd] = ((bus.read8(addr) << 24) >> 24) >>> 0; return;
            case 2: { let v = bus.read16(addr & ~1); if (addr & 1) v = ((v >>> 8) | (v << 24)) >>> 0; r[rd] = v; return; }
            default:
              if (addr & 1) r[rd] = ((bus.read8(addr) << 24) >> 24) >>> 0;
              else r[rd] = ((bus.read16(addr) << 16) >> 16) >>> 0;
              return;
          }
        }
      }
      case 12: { const addr = (r[(op >>> 3) & 7] + ((op >>> 4) & 0x7C)) >>> 0; this.extra += bus.waitN32[(addr >>> 24) & 15]; bus.write32(addr & ~3, r[op & 7]); return; }
      case 13: { const addr = (r[(op >>> 3) & 7] + ((op >>> 4) & 0x7C)) >>> 0; this.extra += bus.waitN32[(addr >>> 24) & 15] + 1; r[op & 7] = this.ldrWord(addr); return; }
      case 14: { const addr = (r[(op >>> 3) & 7] + ((op >>> 6) & 31)) >>> 0; this.extra += bus.waitN16[(addr >>> 24) & 15]; bus.write8(addr, r[op & 7] & 0xFF); return; }
      case 15: { const addr = (r[(op >>> 3) & 7] + ((op >>> 6) & 31)) >>> 0; this.extra += bus.waitN16[(addr >>> 24) & 15] + 1; r[op & 7] = bus.read8(addr); return; }
      case 16: { const addr = (r[(op >>> 3) & 7] + ((op >>> 5) & 0x3E)) >>> 0; this.extra += bus.waitN16[(addr >>> 24) & 15]; bus.write16(addr & ~1, r[op & 7] & 0xFFFF); return; }
      case 17: {
        const addr = (r[(op >>> 3) & 7] + ((op >>> 5) & 0x3E)) >>> 0;
        this.extra += bus.waitN16[(addr >>> 24) & 15] + 1;
        let v = bus.read16(addr & ~1); if (addr & 1) v = ((v >>> 8) | (v << 24)) >>> 0;
        r[op & 7] = v; return;
      }
      case 18: { const addr = (r[13] + ((op & 0xFF) << 2)) >>> 0; this.extra += bus.waitN32[(addr >>> 24) & 15]; bus.write32(addr & ~3, r[(op >>> 8) & 7]); return; }
      case 19: { const addr = (r[13] + ((op & 0xFF) << 2)) >>> 0; this.extra += bus.waitN32[(addr >>> 24) & 15] + 1; r[(op >>> 8) & 7] = this.ldrWord(addr); return; }
      case 20: r[(op >>> 8) & 7] = ((r[15] & ~2) + ((op & 0xFF) << 2)) >>> 0; return;
      case 21: r[(op >>> 8) & 7] = (r[13] + ((op & 0xFF) << 2)) >>> 0; return;
      case 22: case 23:
        if ((op & 0x0F00) === 0) {
          const v = (op & 0x7F) << 2;
          r[13] = (op & 0x80) ? (r[13] - v) >>> 0 : (r[13] + v) >>> 0;
        } else if ((op & 0x0600) === 0x0400) {
          const list = op & 0xFF, R = op & 0x100;
          const n = popcount16(list) + (R ? 1 : 0);
          if (op & 0x800) { // POP
            let addr = r[13];
            this.extra += n * bus.waitN32[(addr >>> 24) & 15] + 1;
            for (let i = 0; i < 8; i++) if (list & (1 << i)) { r[i] = bus.read32(addr & ~3); addr += 4; }
            if (R) { const v = bus.read32(addr & ~3); addr += 4; r[13] = addr >>> 0; this.setPC(v); }
            else r[13] = addr >>> 0;
          } else { // PUSH
            let addr = (r[13] - n * 4) >>> 0;
            r[13] = addr;
            this.extra += n * bus.waitN32[(addr >>> 24) & 15];
            for (let i = 0; i < 8; i++) if (list & (1 << i)) { bus.write32(addr & ~3, r[i]); addr += 4; }
            if (R) bus.write32(addr & ~3, r[14]);
          }
        }
        return;
      case 24: case 25: {
        const rb = (op >>> 8) & 7, list = op & 0xFF;
        let addr = r[rb];
        if (list === 0) {
          if (op & 0x800) this.setPC(bus.read32(addr & ~3));
          else bus.write32(addr & ~3, (r[15] + 2) >>> 0);
          r[rb] = (addr + 0x40) >>> 0; return;
        }
        const n = popcount16(list);
        this.extra += n * bus.waitN32[(addr >>> 24) & 15];
        if (op & 0x800) {
          for (let i = 0; i < 8; i++) if (list & (1 << i)) { r[i] = bus.read32(addr & ~3); addr += 4; }
          if (!(list & (1 << rb))) r[rb] = addr >>> 0;
        } else {
          const fin = (addr + n * 4) >>> 0;
          let first = true;
          for (let i = 0; i < 8; i++) if (list & (1 << i)) {
            const v = i === rb ? (first ? r[rb] : fin) : r[i];
            bus.write32(addr & ~3, v); addr += 4; first = false;
          }
          r[rb] = fin;
        }
        return;
      }
      case 26: case 27: {
        const c = (op >>> 8) & 15;
        if (c === 15) { this.swi(op & 0xFF, pc); return; }
        if (c === 14) return;
        if (this.cond(c)) { r[15] = (r[15] + (((op & 0xFF) << 24) >> 23)) >>> 0; this.branched = true; }
        return;
      }
      case 28: r[15] = (r[15] + (((op & 0x7FF) << 21) >> 20)) >>> 0; this.branched = true; return;
      case 29: return;
      case 30: r[14] = (r[15] + (((op & 0x7FF) << 21) >> 9)) >>> 0; return;
      case 31: {
        const target = (r[14] + ((op & 0x7FF) << 1)) >>> 0;
        r[14] = (pc + 2) | 1;
        r[15] = target & ~1; this.branched = true;
        return;
      }
    }
  }

  // Formato 4 do Thumb: 16 operações entre dois registradores baixos (AND, EOR, deslocamentos, ADC, MUL...).
  thumbAlu(op) {
    const r = this.r;
    const rd = op & 7, a = r[rd], b = r[(op >>> 3) & 7];
    let v;
    switch ((op >>> 6) & 15) {
      case 0: v = (a & b) >>> 0; break;
      case 1: v = (a ^ b) >>> 0; break;
      case 2: v = this.shiftReg(0, a, b & 0xFF); this.C = this.sc; this.extra++; break;
      case 3: v = this.shiftReg(1, a, b & 0xFF); this.C = this.sc; this.extra++; break;
      case 4: v = this.shiftReg(2, a, b & 0xFF); this.C = this.sc; this.extra++; break;
      case 5: r[rd] = this.adcF(a, b); return;
      case 6: r[rd] = this.sbcF(a, b); return;
      case 7: v = this.shiftReg(3, a, b & 0xFF); this.C = this.sc; this.extra++; break;
      case 8: v = (a & b) >>> 0; this.N = v >>> 31; this.Z = v === 0 ? 1 : 0; return;
      case 9: r[rd] = this.subF(0, b); return;
      case 10: this.subF(a, b); return;
      case 11: this.addF(a, b); return;
      case 12: v = (a | b) >>> 0; break;
      case 13: v = Math.imul(a, b) >>> 0; this.extra += 2; break;
      case 14: v = (a & ~b) >>> 0; break;
      default: v = (~b) >>> 0; break;
    }
    r[rd] = v; this.N = v >>> 31; this.Z = v === 0 ? 1 : 0;
  }
}
