'use strict';
// =====================================================================
// bus.js — MEMÓRIA E BARRAMENTO
// =====================================================================
// No GBA, tudo tem um endereço: RAM, tela, sons, botões e o cartucho.
// O byte mais alto do endereço (a >>> 24) diz qual é a região:
//   0x00 BIOS (16 KB)            0x05 Paleta de cores (1 KB)
//   0x02 RAM externa (256 KB)    0x06 Memória de vídeo/VRAM (96 KB)
//   0x03 RAM interna (32 KB)     0x07 Atributos dos sprites/OAM (1 KB)
//   0x04 Registradores de I/O    0x08–0x0D ROM do cartucho (até 32 MB)
//                                0x0E–0x0F Save do cartucho
// Cada região é um Uint8Array com "visões" de 16 e 32 bits
// (Uint16Array/Uint32Array) sobre os mesmos bytes: ler 32 bits vira uma
// única leitura de array, em vez de juntar 4 bytes.
// =====================================================================
// ===================== Barramento de memória =====================
class Bus {
  // fetch16/fetch32 = ciclos para buscar uma instrução em cada região;
  // waitN16/waitN32 = ciclos extras para ler/gravar dados. Usados para o tempo ficar parecido com o real.
  constructor(gba) {
    this.gba = gba;
    this.bios = new Uint8Array(0x4000); this.bios16 = new Uint16Array(this.bios.buffer); this.bios32 = new Uint32Array(this.bios.buffer);
    this.ewram = new Uint8Array(0x40000); this.ewram16 = new Uint16Array(this.ewram.buffer); this.ewram32 = new Uint32Array(this.ewram.buffer);
    this.iwram = new Uint8Array(0x8000); this.iwram16 = new Uint16Array(this.iwram.buffer); this.iwram32 = new Uint32Array(this.iwram.buffer);
    this.pal = new Uint8Array(0x400); this.pal16 = new Uint16Array(this.pal.buffer); this.pal32 = new Uint32Array(this.pal.buffer);
    this.vram = new Uint8Array(0x18000); this.vram16 = new Uint16Array(this.vram.buffer); this.vram32 = new Uint32Array(this.vram.buffer);
    this.oam = new Uint8Array(0x400); this.oam16 = new Uint16Array(this.oam.buffer); this.oam32 = new Uint32Array(this.oam.buffer);
    this.rom = new Uint8Array(4); this.rom16 = new Uint16Array(this.rom.buffer); this.rom32 = new Uint32Array(this.rom.buffer);
    this.romSize = 0;
    this.realBios = false;
    this.biosLast = 0;
    this.fetch16 = new Uint8Array(16); this.fetch32 = new Uint8Array(16);
    this.waitN16 = new Uint8Array(16); this.waitN32 = new Uint8Array(16);
    this.eepromMode = false;
    this.eepromMask = 0;
    this.gpio = null;
    this.installHleBios();
    this.updateWaitstates(0);
  }

  // Como não distribuímos a BIOS da Nintendo, criamos uma mini-BIOS: só as
  // 6 instruções do tratador de interrupção, idênticas às da original.
  // Ele salva registradores, chama a rotina que o jogo guardou em 0x03007FFC e volta.
  installHleBios() {
    this.bios.fill(0);
    // Tratador de IRQ igual ao da BIOS original (em 0x18)
    const code = [
      0xE92D500F, // stmfd sp!, {r0-r3, r12, lr}
      0xE3A00301, // mov r0, #0x04000000
      0xE28FE000, // add lr, pc, #0
      0xE510F004, // ldr pc, [r0, #-4]
      0xE8BD500F, // ldmfd sp!, {r0-r3, r12, lr}
      0xE25EF004, // subs pc, lr, #4
    ];
    for (let i = 0; i < code.length; i++) this.bios32[(0x18 >> 2) + i] = code[i];
    // vetores restantes: laço infinito seguro
    this.bios32[0] = 0xEAFFFFFE; this.bios32[1] = 0xEAFFFFFE; this.bios32[2] = 0xEAFFFFFE;
    this.bios32[3] = 0xEAFFFFFE; this.bios32[4] = 0xEAFFFFFE;
    this.realBios = false;
  }
  // Se a pessoa carregar a gba_bios.bin dela, usamos a BIOS de verdade.
  loadRealBios(data) {
    this.bios.set(data.subarray(0, 0x4000));
    this.realBios = true;
  }

  // Copia a ROM para um buffer com tamanho múltiplo de 4 (exigência das visões de 32 bits).
  loadRom(bytes) {
    const size = Math.min(bytes.length, 0x2000000);
    const alloc = (size + 3) & ~3;
    this.rom = new Uint8Array(alloc);
    this.rom.set(bytes.subarray(0, size));
    this.rom16 = new Uint16Array(this.rom.buffer);
    this.rom32 = new Uint32Array(this.rom.buffer);
    this.romSize = size;
    this.eepromMask = size > 0x1000000 ? 0x0DFFFF00 : 0x0D000000;
  }

  // O registrador WAITCNT (0x04000204) define a velocidade do cartucho.
  // Aqui convertemos essa configuração em ciclos por acesso. "prefetch"
  // é um buffer do GBA que busca instruções adiantado e deixa o cartucho mais rápido.
  updateWaitstates(w) {
    const N = [4, 3, 2, 8];
    const sram = N[w & 3] + 1;
    const ws0n = N[(w >>> 2) & 3], ws0s = (w & 0x10) ? 1 : 2;
    const ws1n = N[(w >>> 5) & 3], ws1s = (w & 0x80) ? 1 : 4;
    const ws2n = N[(w >>> 8) & 3], ws2s = (w & 0x400) ? 1 : 8;
    const pf = (w & 0x4000) !== 0;
    const set = (reg, f16, f32, n16, n32) => { this.fetch16[reg] = f16; this.fetch32[reg] = f32; this.waitN16[reg] = n16; this.waitN32[reg] = n32; };
    for (let i = 0; i < 16; i++) set(i, 1, 1, 0, 0);
    set(2, 3, 6, 2, 5);
    set(5, 1, 2, 0, 1); set(6, 1, 2, 0, 1);
    const romSet = (a, n, s) => {
      const f16 = pf ? 1 : 1 + s, f32 = pf ? 2 : 2 + 2 * s;
      set(a, f16, f32, n, n + 1 + s); set(a + 1, f16, f32, n, n + 1 + s);
    };
    romSet(8, ws0n, ws0s); romSet(10, ws1n, ws1s); romSet(12, ws2n, ws2s);
    set(14, sram, sram, sram, sram); set(15, sram, sram, sram, sram);
  }

  // A VRAM tem 96 KB, mas ocupa um espaço de 128 KB: os últimos 32 KB espelham os 32 KB anteriores.
  vaddr(a) { let o = a & 0x1FFFF; if (o >= 0x18000) o -= 0x8000; return o; }

  // Proteção da BIOS: fora da BIOS, ler a BIOS devolve a última instrução que ela executou (como no hardware).
  biosRead32(a) {
    if (this.gba.cpu.r[15] < 0x4008) return this.bios32[(a & 0x3FFC) >> 2];
    return this.biosLast;
  }

  // Leitura de 8 bits. O switch escolhe a região; "& máscara" faz os espelhos
  // (ex.: a RAM interna se repete a cada 32 KB). Endereços 0xC4–0xC9 da ROM
  // podem ser o relógio (GPIO), e a região 0x0D pode ser o chip EEPROM.
  read8(a) {
    switch (a >>> 24) {
      case 0: if (a < 0x4000) return (this.biosRead32(a) >>> ((a & 3) << 3)) & 0xFF; return 0;
      case 2: return this.ewram[a & 0x3FFFF];
      case 3: return this.iwram[a & 0x7FFF];
      case 4: return this.gba.io.read8(a & 0xFFFFFF);
      case 5: return this.pal[a & 0x3FF];
      case 6: return this.vram[this.vaddr(a)];
      case 7: return this.oam[a & 0x3FF];
      case 8: case 9: case 10: case 11: case 12: case 13: {
        if ((a >>> 24) === 13 && this.eepromMode && a >= this.eepromMask) return this.gba.save.eepromRead();
        const o = a & 0x1FFFFFF;
        if (o < this.romSize) {
          if (o >= 0xC4 && o < 0xCA && this.gpio && this.gpio.readable) return (this.gpio.read(o & ~1) >>> ((o & 1) << 3)) & 0xFF;
          return this.rom[o];
        }
        return ((o >>> 1) >>> ((o & 1) << 3)) & 0xFF;
      }
      case 14: case 15: return this.gba.save.read8(a & 0xFFFF);
      default: return 0;
    }
  }

  // Mesma lógica para 16 bits. A região de save só tem barramento de 8 bits, então o byte é repetido.
  read16(a) {
    switch (a >>> 24) {
      case 0: if (a < 0x4000) return (this.biosRead32(a) >>> ((a & 2) << 3)) & 0xFFFF; return 0;
      case 2: return this.ewram16[(a & 0x3FFFF) >> 1];
      case 3: return this.iwram16[(a & 0x7FFF) >> 1];
      case 4: return this.gba.io.read16(a & 0xFFFFFE);
      case 5: return this.pal16[(a & 0x3FF) >> 1];
      case 6: return this.vram16[this.vaddr(a) >> 1];
      case 7: return this.oam16[(a & 0x3FF) >> 1];
      case 8: case 9: case 10: case 11: case 12: case 13: {
        if ((a >>> 24) === 13 && this.eepromMode && a >= this.eepromMask) return this.gba.save.eepromRead();
        const o = a & 0x1FFFFFE;
        if (o < this.romSize) {
          if (o >= 0xC4 && o < 0xCA && this.gpio && this.gpio.readable) return this.gpio.read(o);
          return this.rom16[o >> 1];
        }
        return (o >>> 1) & 0xFFFF;
      }
      case 14: case 15: return this.gba.save.read8(a & 0xFFFF) * 0x0101;
      default: return 0;
    }
  }

  // Mesma lógica para 32 bits (o caso mais comum para o processador em modo ARM).
  read32(a) {
    switch (a >>> 24) {
      case 0: if (a < 0x4000) return this.biosRead32(a); return 0;
      case 2: return this.ewram32[(a & 0x3FFFF) >> 2];
      case 3: return this.iwram32[(a & 0x7FFF) >> 2];
      case 4: { const o = a & 0xFFFFFC; return (this.gba.io.read16(o) | (this.gba.io.read16(o + 2) << 16)) >>> 0; }
      case 5: return this.pal32[(a & 0x3FF) >> 2];
      case 6: return this.vram32[this.vaddr(a) >> 2];
      case 7: return this.oam32[(a & 0x3FF) >> 2];
      case 8: case 9: case 10: case 11: case 12: case 13: {
        if ((a >>> 24) === 13 && this.eepromMode && a >= this.eepromMask) return this.gba.save.eepromRead();
        const o = a & 0x1FFFFFC;
        if (o < this.romSize) {
          if (o >= 0xC4 && o < 0xCA && this.gpio && this.gpio.readable) return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0;
          return this.rom32[o >> 2];
        }
        return (((o >>> 1) & 0xFFFF) | ((((o + 2) >>> 1) & 0xFFFF) << 16)) >>> 0;
      }
      case 14: case 15: return (this.gba.save.read8(a & 0xFFFF) * 0x01010101) >>> 0;
      default: return 0;
    }
  }

  // Escrita de 8 bits, com as regras do hardware: na paleta e na VRAM o byte é
  // duplicado nos dois lados da meia-palavra; na OAM a escrita de byte é ignorada.
  write8(a, v) {
    switch (a >>> 24) {
      case 2: this.ewram[a & 0x3FFFF] = v; return;
      case 3: this.iwram[a & 0x7FFF] = v; return;
      case 4: this.gba.io.write8(a & 0xFFFFFF, v); return;
      case 5: this.pal16[(a & 0x3FF) >> 1] = (v & 0xFF) * 0x101; return;
      case 6: {
        const o = this.vaddr(a);
        const lim = (this.gba.io.regs[0] & 7) >= 3 ? 0x14000 : 0x10000;
        if (o < lim) this.vram16[o >> 1] = (v & 0xFF) * 0x101;
        return;
      }
      case 8: {
        const o = a & 0x1FFFFFF;
        if (o >= 0xC4 && o < 0xCA && this.gpio) this.gpio.write(o & ~1, v & 0xFF);
        return;
      }
      case 14: case 15: this.gba.save.write8(a & 0xFFFF, v & 0xFF); return;
    }
  }

  // Escrita de 16 bits. Na região 0x0D, cada escrita é 1 bit enviado ao chip EEPROM.
  write16(a, v) {
    switch (a >>> 24) {
      case 2: this.ewram16[(a & 0x3FFFF) >> 1] = v; return;
      case 3: this.iwram16[(a & 0x7FFF) >> 1] = v; return;
      case 4: this.gba.io.write16(a & 0xFFFFFE, v & 0xFFFF); return;
      case 5: this.pal16[(a & 0x3FF) >> 1] = v; return;
      case 6: this.vram16[this.vaddr(a) >> 1] = v; return;
      case 7: this.oam16[(a & 0x3FF) >> 1] = v; return;
      case 8: {
        const o = a & 0x1FFFFFE;
        if (o >= 0xC4 && o < 0xCA && this.gpio) this.gpio.write(o, v & 0xFFFF);
        return;
      }
      case 13: if (this.eepromMode && a >= this.eepromMask) this.gba.save.eepromWrite(v & 1); return;
      case 14: case 15: this.gba.save.write8(a & 0xFFFF, (v >>> ((a & 1) << 3)) & 0xFF); return;
    }
  }

  // Escrita de 32 bits. No I/O vira duas escritas de 16 bits, para reaproveitar a lógica dos registradores.
  write32(a, v) {
    switch (a >>> 24) {
      case 2: this.ewram32[(a & 0x3FFFF) >> 2] = v; return;
      case 3: this.iwram32[(a & 0x7FFF) >> 2] = v; return;
      case 4: { const o = a & 0xFFFFFC; this.gba.io.write16(o, v & 0xFFFF); this.gba.io.write16(o + 2, v >>> 16); return; }
      case 5: this.pal32[(a & 0x3FF) >> 2] = v; return;
      case 6: this.vram32[this.vaddr(a) >> 2] = v; return;
      case 7: this.oam32[(a & 0x3FF) >> 2] = v; return;
      case 8: this.write16(a & ~3, v & 0xFFFF); this.write16((a & ~3) + 2, v >>> 16); return;
      case 13: if (this.eepromMode && a >= this.eepromMask) this.gba.save.eepromWrite(v & 1); return;
      case 14: case 15: this.gba.save.write8(a & 0xFFFF, (v >>> ((a & 3) << 3)) & 0xFF); return;
    }
  }
}
