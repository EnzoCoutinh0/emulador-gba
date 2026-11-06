typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u16 vu16; typedef volatile u32 vu32;
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
__attribute__((used, aligned(4))) const char tag[] = "EEPROM_V124";
static void dma3(void *s, void *d, u32 n) { *(vu32 *)0x040000D4 = (u32)s; *(vu32 *)0x040000D8 = (u32)d; *(vu32 *)0x040000DC = n | (0x8000u << 16); }
u16 buf[81];
int main(void) {
  vu32 *out = (vu32 *)0x02000000;
  u32 addr = 5; u8 data[8] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
  int p = 0; buf[p++] = 1; buf[p++] = 0;
  for (int i = 13; i >= 0; i--) buf[p++] = (addr >> i) & 1;
  for (int b = 0; b < 8; b++) for (int i = 7; i >= 0; i--) buf[p++] = (data[b] >> i) & 1;
  buf[p++] = 0;
  dma3(buf, (void *)0x0D000000, 81);
  while (!(*(vu16 *)0x0D000000 & 1)) {}
  p = 0; buf[p++] = 1; buf[p++] = 1;
  for (int i = 13; i >= 0; i--) buf[p++] = (addr >> i) & 1;
  buf[p++] = 0;
  dma3(buf, (void *)0x0D000000, 17);
  dma3((void *)0x0D000000, buf, 68);
  u32 hi = 0, lo = 0;
  for (int i = 0; i < 32; i++) hi = (hi << 1) | (buf[4 + i] & 1);
  for (int i = 0; i < 32; i++) lo = (lo << 1) | (buf[36 + i] & 1);
  out[0] = hi; out[1] = lo; out[15] = 0xDEADBEEF;
  for (;;) {}
}
