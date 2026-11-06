typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8; typedef volatile u8 vu8; typedef volatile u16 vu16; typedef volatile u32 vu32;
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
__attribute__((used, aligned(4))) const char tag[] = "FLASH1M_V103";
#define F ((vu8 *)0x0E000000)
static void cmd(u8 c) { F[0x5555] = 0xAA; F[0x2AAA] = 0x55; F[0x5555] = c; }
static void wr(u32 a, u8 v) { cmd(0xA0); F[a] = v; while (F[a] != v) {} }
#define GP(o) (*(vu16 *)(0x08000000 + (o)))
static void rtc_cmd(u8 v) { for (int i = 0; i < 8; i++) { u16 b = (v >> (7 - i)) & 1; GP(0xC4) = (b << 1) | 4; GP(0xC4) = (b << 1) | 4; GP(0xC4) = (b << 1) | 5; } }
static u8 rtc_rd(void) { u8 v = 0; for (int i = 0; i < 8; i++) { GP(0xC4) = 4; GP(0xC4) = 4; GP(0xC4) = 5; v = (v >> 1) | (((GP(0xC4) >> 1) & 1) << 7); } return v; }
int main(void) {
  vu32 *out = (vu32 *)0x02000000;
  cmd(0x90); out[0] = F[0] | (F[1] << 8); cmd(0xF0);   // ID
  cmd(0x80); cmd(0x10);                                  // apaga tudo
  for (int i = 0; i < 16; i++) wr(0x100 + i, i * 3);
  cmd(0xB0); F[0] = 1;                                   // banco 1
  wr(0x200, 0x77);
  cmd(0xB0); F[0] = 0;
  out[1] = F[0x100 + 5] | (F[0x100 + 15] << 8) | (F[0x200] << 16);
  cmd(0x80); F[0x1000] = 0xAA; F[0x0000] = 0; // (sequência inválida de propósito)
  F[0x5555] = 0xAA; F[0x2AAA] = 0x55; F[0x5555] = 0x80; F[0x5555] = 0xAA; F[0x2AAA] = 0x55; F[0x0000] = 0x30; // apaga setor 0
  out[2] = F[0x105];
  // RTC
  GP(0xC8) = 1; GP(0xC4) = 1; GP(0xC4) = 5; GP(0xC6) = 7;
  rtc_cmd(0x63); GP(0xC6) = 5; out[3] = rtc_rd(); GP(0xC4) = 1;
  GP(0xC4) = 1; GP(0xC4) = 5; GP(0xC6) = 7;
  rtc_cmd(0x65); GP(0xC6) = 5;
  u32 a = 0, b = 0; for (int i = 0; i < 4; i++) a |= rtc_rd() << (i * 8); for (int i = 0; i < 3; i++) b |= rtc_rd() << (i * 8);
  GP(0xC4) = 1;
  out[4] = a; out[5] = b;
  out[15] = 0xDEADBEEF;
  for (;;) {}
}
