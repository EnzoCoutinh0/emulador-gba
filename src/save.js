'use strict';
// =====================================================================
// save.js — CHIPS DE SAVE E RELÓGIO (RTC)
// =====================================================================
// Cartuchos de GBA guardam o save em um destes chips:
//   • SRAM (32 KB): memória comum alimentada por bateria. Lê e grava direto.
//   • Flash (64 KB ou 128 KB): precisa de "comandos" para gravar e apagar.
//     É o que os Pokémon usam (128 KB).
//   • EEPROM (512 B ou 8 KB): conversa bit a bit, por DMA.
// Os dados ficam em this.data; dirty = true avisa a interface que há algo
// novo para guardar.
// =====================================================================
// ===================== Saves (SRAM / Flash / EEPROM) e RTC =====================
class SaveMemory {
  constructor(type) {
    this.type = type; // 'none' | 'sram' | 'flash64' | 'flash128' | 'eeprom'
    this.dirty = false;
    this.state = 0; this.idMode = false; this.erasePrep = false; this.bank = 0;
    // EEPROM
    this.eBits = 0; this.eBuf = []; this.eAddrBits = 14; this.eSizeKnown = false;
    this.eReadAddr = -1; this.eReadPos = 0;
    let size = 0;
    switch (type) {
      case 'sram': size = 0x8000; break;
      case 'flash64': size = 0x10000; break;
      case 'flash128': size = 0x20000; break;
      case 'eeprom': size = 0x2000; break;
      default: size = 0;
    }
    this.data = new Uint8Array(size).fill(0xFF);
    if (type === 'flash64') { this.manuf = 0x32; this.device = 0x1B; }
    else { this.manuf = 0xC2; this.device = 0x09; }
  }

  // Leitura: na Flash, depois do comando 0x90 os dois primeiros bytes devolvem o fabricante e o modelo do chip (o jogo confere isso).
  read8(addr) {
    switch (this.type) {
      case 'sram': return this.data[addr & 0x7FFF];
      case 'flash64': case 'flash128':
        if (this.idMode && addr < 2) return addr === 0 ? this.manuf : this.device;
        return this.data[(this.bank << 16) | addr];
      default: return 0xFF;
    }
  }

  // Escrita. A Flash só aceita gravar depois de uma "senha": AA no endereço 5555,
  // 55 em 2AAA e então o comando (90 = identificar, 80 = preparar apagamento,
  // 10 = apagar tudo, 30 = apagar um setor de 4 KB, A0 = gravar 1 byte,
  // B0 = trocar de banco de 64 KB). this.state guarda em que passo da senha estamos.
  write8(addr, v) {
    if (this.type === 'sram') { this.data[addr & 0x7FFF] = v; this.dirty = true; return; }
    if (this.type !== 'flash64' && this.type !== 'flash128') return;
    switch (this.state) {
      case 0:
        if (addr === 0x5555 && v === 0xAA) this.state = 1;
        else if (v === 0xF0) this.idMode = false;
        return;
      case 1:
        this.state = (addr === 0x2AAA && v === 0x55) ? 2 : 0;
        return;
      case 2:
        this.state = 0;
        if (addr === 0x5555) {
          switch (v) {
            case 0x90: this.idMode = true; break;
            case 0xF0: this.idMode = false; break;
            case 0x80: this.erasePrep = true; break;
            case 0xA0: this.state = 3; break;
            case 0xB0: if (this.type === 'flash128') this.state = 4; break;
            case 0x10: if (this.erasePrep) { this.data.fill(0xFF); this.dirty = true; } this.erasePrep = false; break;
          }
        } else if (v === 0x30 && this.erasePrep) {
          const base = (this.bank << 16) | (addr & 0xF000);
          this.data.fill(0xFF, base, base + 0x1000);
          this.erasePrep = false; this.dirty = true;
        }
        return;
      case 3:
        this.data[(this.bank << 16) | addr] = v; this.dirty = true; this.state = 0;
        return;
      case 4:
        if (addr === 0) this.bank = v & 1;
        this.state = 0;
        return;
    }
  }

  // ---- EEPROM (acesso serial via DMA) ----
  // A EEPROM tem dois tamanhos; descobrimos qual pelo número de bits que o jogo manda no primeiro acesso.
  eepromDmaCount(count) {
    if (this.eSizeKnown) return;
    if (count === 9 || count === 73) { this.eAddrBits = 6; this.eSizeKnown = true; }
    else if (count === 17 || count === 81) { this.eAddrBits = 14; this.eSizeKnown = true; }
  }
  // Recebe 1 bit por vez. Comando "11" + endereço = pedido de leitura;
  // "10" + endereço + 64 bits de dados = gravação de 8 bytes.
  eepromWrite(bit) {
    this.eBuf.push(bit);
    const n = this.eBuf.length, ab = this.eAddrBits;
    if (n < 2) return;
    const cmd = (this.eBuf[0] << 1) | this.eBuf[1];
    if (cmd === 3) { // pedido de leitura
      if (n === 2 + ab + 1) {
        let a = 0; for (let i = 0; i < ab; i++) a = (a << 1) | this.eBuf[2 + i];
        this.eReadAddr = (a & 0x3FF) * 8; this.eReadPos = 0; this.eBuf = [];
      }
    } else if (cmd === 2) { // escrita
      if (n === 2 + ab + 64 + 1) {
        let a = 0; for (let i = 0; i < ab; i++) a = (a << 1) | this.eBuf[2 + i];
        const base = (a & 0x3FF) * 8;
        for (let byte = 0; byte < 8; byte++) {
          let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | this.eBuf[2 + ab + byte * 8 + b];
          if (base + byte < this.data.length) this.data[base + byte] = v;
        }
        this.dirty = true; this.eBuf = []; this.eReadAddr = -1;
      }
    } else this.eBuf = [];
  }
  // Devolve 4 bits de lixo e depois os 64 bits pedidos. Sem leitura pendente, devolve 1 (= "pronto").
  eepromRead() {
    if (this.eReadAddr < 0) return 1;
    const p = this.eReadPos++;
    if (p < 4) return 0;
    const q = p - 4;
    const idx = this.eReadAddr + (q >> 3);
    const bit = idx < this.data.length ? (this.data[idx] >> (7 - (q & 7))) & 1 : 1;
    if (this.eReadPos >= 68) this.eReadAddr = -1;
    return bit;
  }
}

// Descobre o tipo de save procurando na ROM os textos que a biblioteca da
// Nintendo deixa nos jogos ("FLASH1M_V", "EEPROM_V", "SRAM_V"...).
function detectSaveType(rom) {
  const tags = [['EEPROM_V', 'eeprom'], ['SRAM_V', 'sram'], ['SRAM_F_V', 'sram'], ['FLASH_V', 'flash64'], ['FLASH512_V', 'flash64'], ['FLASH1M_V', 'flash128']];
  const codes = tags.map(t => Array.from(t[0]).map(c => c.charCodeAt(0)));
  const n = rom.length;
  for (let i = 0; i < n; i += 4) {
    const c = rom[i];
    if (c !== 0x45 && c !== 0x53 && c !== 0x46) continue;
    for (let t = 0; t < codes.length; t++) {
      const s = codes[t];
      if (s[0] !== c) continue;
      let ok = true;
      for (let k = 1; k < s.length; k++) if (i + k >= n || rom[i + k] !== s[k]) { ok = false; break; }
      if (ok) return tags[t][1];
    }
  }
  return 'sram';
}

// RTC Seiko S-3511 via GPIO (Pokémon Ruby/Sapphire/Emerald)
// ---------------------------------------------------------------------
// RELÓGIO (RTC Seiko S-3511), usado por Pokémon Ruby, Sapphire e Emerald
// para o dia e a hora do jogo (frutas, maré, eventos).
// Ele conversa por 3 fios (pinos GPIO em 0x080000C4): SCK (relógio),
// SIO (dados) e CS (seleção). O jogo envia um comando de 8 bits e depois
// lê ou grava os bytes de data e hora, em BCD (ex.: 59 minutos = 0x59).
// Usamos a data e a hora do seu computador.
// ---------------------------------------------------------------------
class GpioRtc {
  constructor() {
    this.pins = 0; this.dir = 0; this.readable = 0;
    this.state = 0; this.bits = 0; this.cmd = 0; this.data = []; this.len = 0; this.reg = 0;
    this.lastSck = 0; this.lastCs = 0; this.sioOut = 0;
    this.control = 0x40;
  }
  read(o) {
    switch (o) {
      case 0xC4: { let v = this.pins & this.dir & 0xF; if (!(this.dir & 2)) v |= this.sioOut << 1; return v; }
      case 0xC6: return this.dir;
      case 0xC8: return this.readable;
    }
    return 0;
  }
  bcd(x) { return ((Math.floor(x / 10) << 4) | (x % 10)) & 0xFF; }
  // O jogo mexe nos pinos. Cada subida do SCK com CS ligado transfere 1 bit (função clock).
  write(o, v) {
    if (o === 0xC8) { this.readable = v & 1; return; }
    if (o === 0xC6) { this.dir = v & 0xF; return; }
    if (o !== 0xC4) return;
    const pins = (this.pins & ~this.dir) | (v & this.dir) & 0xF;
    this.pins = pins;
    const sck = pins & 1, sio = (pins >> 1) & 1, cs = (pins >> 2) & 1;
    if (!cs) { this.state = 0; }
    else {
      if (!this.lastCs) { this.state = 1; this.bits = 0; this.cmd = 0; }
      if (sck && !this.lastSck) this.clock(sio);
    }
    this.lastSck = sck; this.lastCs = cs;
  }
  clock(sio) {
    if (this.state === 1) {
      this.cmd = ((this.cmd << 1) | sio) & 0xFF; this.bits++;
      if (this.bits === 8) this.command();
    } else if (this.state === 2) {
      const i = this.bits >> 3;
      this.sioOut = i < this.data.length ? (this.data[i] >> (this.bits & 7)) & 1 : 0;
      this.bits++;
      if (this.bits >= this.len * 8) this.state = 0;
    } else if (this.state === 3) {
      const i = this.bits >> 3;
      if ((this.bits & 7) === 0) this.data[i] = 0;
      this.data[i] |= sio << (this.bits & 7);
      this.bits++;
      if (this.bits >= this.len * 8) {
        if (this.reg === 1) this.control = this.data[0] & 0xFF;
        this.state = 0;
      }
    }
  }
  // Interpreta o comando: 0110 + registrador + leitura/escrita.
  // Registradores: 0 = reset, 1 = estado/controle, 2 = data e hora (7 bytes), 3 = só a hora (3 bytes).
  command() {
    let c = this.cmd;
    if ((c >> 4) !== 6) { // ordem de bits invertida
      let rv = 0; for (let i = 0; i < 8; i++) rv |= ((c >> i) & 1) << (7 - i);
      c = rv;
    }
    if ((c >> 4) !== 6) { this.state = 0; return; }
    const reg = (c >> 1) & 7, rd = c & 1;
    this.reg = reg; this.bits = 0;
    const lens = [0, 1, 7, 3, 0, 0, 0, 0];
    this.len = lens[reg];
    if (reg === 0) { this.control = 0; this.state = 0; return; }
    if (this.len === 0) { this.state = 0; return; }
    if (rd) {
      const d = new Date();
      const hour = d.getHours();
      const h = (this.control & 0x40) ? this.bcd(hour) : (this.bcd(hour % 12) | (hour >= 12 ? 0x80 : 0));
      if (reg === 1) this.data = [this.control];
      else if (reg === 2) this.data = [this.bcd(d.getFullYear() % 100), this.bcd(d.getMonth() + 1), this.bcd(d.getDate()), d.getDay(), h, this.bcd(d.getMinutes()), this.bcd(d.getSeconds())];
      else this.data = [h, this.bcd(d.getMinutes()), this.bcd(d.getSeconds())];
      this.state = 2;
    } else { this.data = []; this.state = 3; }
  }
}
