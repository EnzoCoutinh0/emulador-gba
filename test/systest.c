typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u16 vu16; typedef volatile u32 vu32;
#include "lzdata.h"
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
#define REG16(a) (*(vu16 *)(a))
#define REG32(a) (*(vu32 *)(a))
extern void irq_handler(void);
volatile u32 vbl_count, tm_count, irq_flags_seen;
static inline void vblank_wait(void) { __asm__ volatile("svc 5" ::: "r0", "r1", "r2", "r3", "memory"); }
static inline u32 bios_div(int a, int b, int *rem) { register int r0 __asm__("r0") = a; register int r1 __asm__("r1") = b; __asm__ volatile("svc 6" : "+r"(r0), "+r"(r1) :: "r3", "memory"); *rem = r1; return r0; }
static inline u32 bios_sqrt(u32 a) { register u32 r0 __asm__("r0") = a; __asm__ volatile("svc 8" : "+r"(r0) :: "r1", "r3", "memory"); return r0; }
static inline void bios_lz77(const void *s, void *d) { register const void *r0 __asm__("r0") = s; register void *r1 __asm__("r1") = d; __asm__ volatile("svc 0x11" : "+r"(r0), "+r"(r1) :: "r2", "r3", "memory"); }
static inline void bios_lz77v(const void *s, void *d) { register const void *r0 __asm__("r0") = s; register void *r1 __asm__("r1") = d; __asm__ volatile("svc 0x12" : "+r"(r0), "+r"(r1) :: "r2", "r3", "memory"); }

int main(void) {
  vu32 *out = (vu32 *)0x02000000;
  REG32(0x03007FFC) = (u32)irq_handler;
  REG16(0x04000004) = 1 << 3;           // vblank irq
  REG16(0x04000200) = 1 | (1 << 3);     // IE: vblank + timer0
  REG16(0x04000208) = 1;
  // 0: 10 VBlankIntrWait
  for (int i = 0; i < 10; i++) vblank_wait();
  out[0] = vbl_count;                    // esperado 10
  // 1: timer0 prescaler 1024, reload 0xFF00, IRQ
  REG16(0x04000100) = 0xFF00;
  REG16(0x04000102) = 0x80 | 0x40 | 3;
  for (int i = 0; i < 60; i++) vblank_wait();
  out[1] = tm_count;                     // ~64
  REG16(0x04000102) = 0;
  // 2: DMA3 copia 1024 bytes de ROM para EWRAM
  REG32(0x040000D4) = (u32)lz_orig; REG32(0x040000D8) = 0x02010000; REG32(0x040000DC) = (256) | (0x8400u << 16);
  u32 ok = 1; for (int i = 0; i < 1024; i++) if (((u8 *)0x02010000)[i] != lz_orig[i]) ok = 0;
  out[2] = ok;
  // 3: LZ77 Wram
  bios_lz77(lz_src, (void *)0x02020000);
  ok = 1; for (u32 i = 0; i < sizeof(lz_orig); i++) if (((u8 *)0x02020000)[i] != lz_orig[i]) ok = 0;
  out[3] = ok;
  // 4: LZ77 Vram
  bios_lz77v(lz_src, (void *)0x06004000);
  ok = 1; for (u32 i = 0; i < sizeof(lz_orig); i++) if (((vu16 *)0x06004000)[i/2] >> ((i&1)*8) & 0xFF ^ lz_orig[i]) ok = 0;
  out[4] = ok;
  // 5: Div e Sqrt
  int rem; u32 q = bios_div(-1000, 7, &rem);
  out[5] = q; out[6] = rem; out[7] = bios_sqrt(1000000);
  // 8: timer cascata (count-up)
  REG16(0x04000104) = 0; REG16(0x04000108) = 0;
  REG16(0x0400010A) = 0x84;              // timer2 count-up
  REG16(0x04000106) = 0x80;              // timer1 prescaler 1
  for (int i = 0; i < 2; i++) vblank_wait();
  out[8] = REG16(0x04000108);            // ~ 2*280896/65536 = 8
  out[9] = irq_flags_seen;
  out[15] = 0xDEADBEEF;
  for (;;) vblank_wait();
}
