typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u16 vu16; typedef volatile u32 vu32;
__attribute__((used, aligned(4))) const char tag[] = "SRAM_V113";
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
#define R16(a) (*(vu16 *)(a))
// cenário pesado: 4 BGs, 128 sprites 32x32, blending, janela, CPU ocupada com vblank wait a cada quadro (como um jogo)
static inline void vbl(void) { __asm__ volatile("svc 5" ::: "r0", "r1", "r2", "r3", "memory"); }
extern void irq_handler(void);
volatile u32 vbl_count, tm_count, irq_flags_seen;
u32 __aeabi_uidivmod_dummy;
u32 __aeabi_uidiv(u32 n, u32 d) { u32 q = 0, r = 0; for (int i = 31; i >= 0; i--) { r = (r << 1) | ((n >> i) & 1); if (r >= d) { r -= d; q |= 1u << i; } } return q; }
unsigned long long __aeabi_uidivmod(u32 n, u32 d) { u32 q = __aeabi_uidiv(n, d); return ((unsigned long long)(n - q * d) << 32) | q; }
u32 seed = 1; u32 rnd(void) { seed = seed * 1103515245 + 12345; return seed >> 8; }
int main(void) {
  *(vu32 *)0x03007FFC = (u32)irq_handler;
  R16(0x04000004) = 8; R16(0x04000200) = 1; R16(0x04000208) = 1;
  vu16 *vram = (vu16 *)0x06000000, *pal = (vu16 *)0x05000000, *oam = (vu16 *)0x07000000;
  for (int i = 0; i < 512; i++) pal[i] = rnd();
  for (int i = 0; i < 0x8000; i++) vram[i] = rnd();
  for (int i = 0; i < 0x4000; i++) vram[0x8000 + i] = rnd();
  for (int b = 0; b < 4; b++) R16(0x04000008 + b * 2) = (b << 2 & 4) | ((24 + b) << 8) | b;
  R16(0x04000050) = 0x3F41; R16(0x04000052) = 0x0808;
  R16(0x04000000) = 0x1F40 | 0x2000; R16(0x04000040) = 0x10E0; R16(0x04000044) = 0x1090; R16(0x04000048) = 0x3F3F; R16(0x0400004A) = 0x3F;
  for (u32 f = 0;; f++) {
    for (int i = 0; i < 128; i++) { oam[i * 4] = ((i * 7 + f) & 127) | (0 << 14); oam[i * 4 + 1] = ((i * 13 + f) % 240) | (2 << 14); oam[i * 4 + 2] = (i * 16) & 0x3FF; }
    for (int b = 0; b < 4; b++) { R16(0x04000010 + b * 4) = f * (b + 1); R16(0x04000012 + b * 4) = f; }
    volatile u32 x = 0; for (int k = 0; k < 15000; k++) x += k;   // ~ meio quadro de CPU
    *(vu32 *)0x02000000 = f; for (int k = 0; k < 64; k++) ((volatile u8 *)0x0E000000)[(f * 64 + k) & 0x7FFF] = f + k;
    vbl();
  }
}
