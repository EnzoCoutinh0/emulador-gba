typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u16 vu16; typedef volatile u32 vu32;
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
#include "sine.h"
#define R16(a) (*(vu16 *)(a))
#define R32(a) (*(vu32 *)(a))
int main(void) {
  R16(0x04000084) = 0x80;                    // master on
  R16(0x04000082) = 0x0B04 | 0x0300;         // DMA A 100%, L+R, timer0, reset
  R32(0x040000BC) = (u32)sine; R32(0x040000C0) = 0x040000A0;
  R32(0x040000C4) = 0xB6400000;              // DMA1: repeat, 32bit, special, enable, dst fixed
  R16(0x04000100) = 65536 - 512;             // 32768 Hz de amostragem => seno de 1024 Hz
  R16(0x04000102) = 0x80;
  for (;;) {}
}
