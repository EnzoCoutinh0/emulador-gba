typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u16 vu16; typedef volatile u32 vu32;
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
#define REG16(a) (*(vu16 *)(a))
#define RGB(r,g,b) ((r)|((g)<<5)|((b)<<10))
vu16 *const PAL = (vu16 *)0x05000000; vu16 *const VRAM = (vu16 *)0x06000000; vu16 *const OAM = (vu16 *)0x07000000;
int main(void) {
  // paleta BG: banco 0
  PAL[0] = RGB(4, 4, 8);           // fundo
  PAL[1] = RGB(31, 0, 0); PAL[2] = RGB(0, 31, 0); PAL[3] = RGB(0, 0, 31); PAL[4] = RGB(31, 31, 0);
  PAL[16 + 1] = RGB(31, 31, 31);   // banco 1
  // tiles 4bpp em charblock 0: tile1 = xadrez cores 1/2, tile2 = quadrado borda cor 4
  for (int y = 0; y < 8; y++) {
    u32 row = 0, row2 = 0;
    for (int x = 0; x < 8; x++) { row |= ((((x >> 1) ^ (y >> 1)) & 1) ? 1 : 2) << (x * 4); row2 |= ((x == 0 || y == 0 || x == 7 || y == 7) ? 4 : 0) << (x * 4); }
    VRAM[(32 + y * 4) / 2] = row; VRAM[(32 + y * 4) / 2 + 1] = row >> 16;
    VRAM[(64 + y * 4) / 2] = row2; VRAM[(64 + y * 4) / 2 + 1] = row2 >> 16;
  }
  // tile3: diagonal cor 1 (banco 1 => branco), para testar flips
  for (int y = 0; y < 8; y++) { u32 row = 0; for (int x = 0; x <= y; x++) row |= 1 << (x * 4); VRAM[(96 + y * 4) / 2] = row; VRAM[(96 + y * 4) / 2 + 1] = row >> 16; }
  // mapa BG0 (screenblock 8 = 0x4000): xadrez em metade, bordas
  vu16 *map0 = VRAM + 0x4000 / 2, *map1 = VRAM + 0x4800 / 2;
  for (int i = 0; i < 1024; i++) { int x = i & 31, y = i >> 5; map0[i] = (x < 15) ? 1 : 0; map1[i] = ((x + y) % 3 == 0) ? (2) : (y > 12 ? 3 | (1 << 12) | ((x & 1) << 10) | ((x & 2) << 10) : 0); }
  REG16(0x04000008) = (8 << 8) | 1;          // BG0: prio 1
  REG16(0x0400000A) = (9 << 8) | 0;          // BG1: prio 0
  REG16(0x04000010) = 4; REG16(0x04000012) = 2; // scroll BG0
  // sprites: paleta OBJ
  PAL[256 + 1] = RGB(31, 16, 0); PAL[256 + 2] = RGB(16, 0, 31);
  // tile OBJ 0..3 (32x... usa 1D) : bloco 16x16 com cores 1 e 2
  vu16 *ot = VRAM + 0x10000 / 2;
  for (int t = 0; t < 4; t++) for (int y = 0; y < 8; y++) { u32 row = 0; for (int x = 0; x < 8; x++) row |= (t == 0 || t == 3 ? 1 : 2) << (x * 4); if (y == 0 && t == 0) row = 0x22222222; ot[t * 16 + y * 2] = row; ot[t * 16 + y * 2 + 1] = row >> 16; }
  for (int i = 0; i < 128; i++) OAM[i * 4] = 0x200; // desativa todos
  OAM[0] = 20 | (0 << 14); OAM[1] = 150 | (1 << 14); OAM[2] = 0 | (0 << 10);                 // 16x16 normal prio0
  OAM[4] = 60 | (0 << 14) | (1 << 10); OAM[5] = 180 | (1 << 14); OAM[6] = 0;                 // semi-transparente
  OAM[8] = 100 | 0x300; OAM[9] = 150 | (1 << 14) | (1 << 9); OAM[10] = 0;                    // afim dupla, param 1
  // parâmetro afim 1: rotação 45°, escala 1 (0.707*256=181)
  OAM[16 + 3] = 181; OAM[16 + 7] = -181; OAM[16 + 11] = 181; OAM[16 + 15] = 181;
  REG16(0x04000050) = (1 << 4) | (1 << 6) | (1 << 8) | (1 << 9); // alpha: 1º alvo OBJ, 2º BG0/BG1
  REG16(0x04000052) = 8 | (8 << 8);
  // janela 0: retângulo onde BG1 some
  REG16(0x04000040) = (10 << 8) | 60; REG16(0x04000044) = (100 << 8) | 150;
  REG16(0x04000048) = 0x3D;  // dentro: tudo menos BG1
  REG16(0x0400004A) = 0x3F;
  REG16(0x04000000) = (1 << 8) | (1 << 9) | (1 << 12) | (1 << 6) | (1 << 13);
  *(vu32 *)0x0200003C = 0xDEADBEEF;
  for (;;) {}
}
