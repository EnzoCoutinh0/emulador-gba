#!/usr/bin/env python3
# Preenche o cabeçalho da ROM: título, código do jogo, versão e o checksum do cabeçalho.
# (Para rodar num GBA de verdade, passe também o gbafix do devkitPro, que insere o logotipo exigido pelo console.)
import sys
p = sys.argv[1]; rom = bytearray(open(p, 'rb').read())
rom[0xA0:0xAC] = b'ASTRODEFENS'.ljust(12, b'\0')
rom[0xAC:0xB0] = b'AADP'
rom[0xB0:0xB2] = b'00'
rom[0xB2] = 0x96
rom[0xBC] = 0
chk = 0
for b in rom[0xA0:0xBD]: chk = (chk - b) & 0xFF
rom[0xBD] = (chk - 0x19) & 0xFF
while len(rom) % 4: rom.append(0)
open(p, 'wb').write(rom)
print('cabeçalho ok:', p, len(rom), 'bytes')
