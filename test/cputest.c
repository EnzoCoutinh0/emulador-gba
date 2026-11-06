typedef unsigned int u32; typedef int s32; typedef unsigned short u16; typedef short s16;
typedef unsigned char u8; typedef signed char s8; typedef unsigned long long u64; typedef long long s64;

#ifdef NATIVE
#include <stdio.h>
#define NOINLINE __attribute__((noinline))
#else
#define NOINLINE __attribute__((noinline))
u32 __aeabi_uidiv(u32 n, u32 d) { u32 q = 0, r = 0; for (int i = 31; i >= 0; i--) { r = (r << 1) | ((n >> i) & 1); if (r >= d) { r -= d; q |= 1u << i; } } return q; }
s32 __aeabi_idiv(s32 n, s32 d) { int neg = (n < 0) ^ (d < 0); u32 q = __aeabi_uidiv(n < 0 ? -(u32)n : n, d < 0 ? -(u32)d : d); return neg ? -(s32)q : (s32)q; }
typedef struct { u32 q, r; } qr;
u64 __aeabi_uidivmod(u32 n, u32 d) { u32 q = __aeabi_uidiv(n, d); u32 r = n - q * d; return ((u64)r << 32) | q; }
s64 __aeabi_idivmod(s32 n, s32 d) { s32 q = __aeabi_idiv(n, d); s32 r = n - q * d; return ((u64)(u32)r << 32) | (u32)q; }
void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = c; return d; }
#endif

static u32 seed = 12345;
NOINLINE u32 rnd(void) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }
NOINLINE u32 rotl(u32 x, u32 n) { n &= 31; return n ? (x << n) | (x >> (32 - n)) : x; }
NOINLINE u32 mix(u32 h, u32 v) { h ^= v; h *= 0x9E3779B1u; h = rotl(h, 13); return h + 0x7F4A7C15u; }

volatile u32 vsink;
struct S { u32 a, b, c, d, e, f, g; s16 h; s8 i; u8 j; };

NOINLINE u32 fib(u32 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
NOINLINE u32 sw(u32 x) {
  switch (x % 9) { case 0: return x * 3; case 1: return x ^ 0x55; case 2: return x - 7; case 3: return ~x; case 4: return x >> 3;
    case 5: return x << 5; case 6: return (s32)x >> 4; case 7: return x | 0x1010; default: return x & 0xF0F0; }
}
typedef u32 (*fn)(u32);
NOINLINE u32 f1(u32 x) { return x + 1; }
NOINLINE u32 f2(u32 x) { return x * 7; }
NOINLINE u32 f3(u32 x) { return x ^ (x >> 3); }

u32 results[16];

NOINLINE void tests(void) {
  u32 h = 0;
  // 1: ALU / shifts
  for (int i = 0; i < 2000; i++) {
    u32 a = rnd(), b = rnd(), s = rnd() & 31;
    h = mix(h, a + b); h = mix(h, a - b); h = mix(h, a & ~b); h = mix(h, a | b); h = mix(h, a ^ b);
    h = mix(h, a << s); h = mix(h, a >> s); h = mix(h, (u32)((s32)a >> s)); h = mix(h, rotl(a, s));
    h = mix(h, (s32)a < (s32)b); h = mix(h, a < b); h = mix(h, a * b); h = mix(h, a * b + s);
    h = mix(h, (s32)a > 0 ? a : -a);
  }
  results[0] = h;
  // 2: 64-bit
  h = 0;
  u64 acc = 0; s64 sacc = 0;
  for (int i = 0; i < 2000; i++) {
    u32 a = rnd(), b = rnd();
    u64 p = (u64)a * b; s64 q = (s64)(s32)a * (s32)b;
    acc += p; sacc -= q;
    h = mix(h, (u32)p); h = mix(h, (u32)(p >> 32)); h = mix(h, (u32)q); h = mix(h, (u32)(q >> 32));
    h = mix(h, (u32)acc); h = mix(h, (u32)(acc >> 32)); h = mix(h, (u32)(sacc >> 32));
    u64 x = ((u64)a << 32) | b; x = (x << (b & 31)) ^ (x >> (a & 15));
    h = mix(h, (u32)x); h = mix(h, (u32)(x >> 32));
    h = mix(h, (s64)x < (s64)acc);
  }
  results[1] = h;
  // 3: division
  h = 0;
  for (int i = 0; i < 500; i++) {
    u32 a = rnd(), b = (rnd() >> (rnd() & 31)) | 1;
    h = mix(h, a / b); h = mix(h, a % b); h = mix(h, (u32)((s32)a / (s32)b)); h = mix(h, (u32)((s32)a % (s32)b));
  }
  results[2] = h;
  // 4: memória byte/halfword
  h = 0;
  static s8 cb[256]; static s16 sb[256]; static u16 ub[256]; static u8 bb[256];
  for (int i = 0; i < 256; i++) { u32 r = rnd(); cb[i] = r; sb[i] = r >> 8; ub[i] = r >> 12; bb[i] = r >> 20; }
  for (int k = 0; k < 20; k++)
    for (int i = 0; i < 256; i++) {
      int j = (i * 37 + k) & 255;
      h = mix(h, cb[j]); h = mix(h, sb[j]); h = mix(h, ub[j]); h = mix(h, bb[j]);
      cb[j] += sb[i]; sb[j] ^= ub[i]; ub[j] -= bb[i]; bb[j] += (u8)cb[i];
    }
  results[3] = h;
  // 5: structs (ldm/stm), recursão, switch, ponteiros de função
  h = 0;
  struct S s1, s2;
  s1.a = rnd(); s1.b = rnd(); s1.c = rnd(); s1.d = rnd(); s1.e = rnd(); s1.f = rnd(); s1.g = rnd(); s1.h = rnd(); s1.i = rnd(); s1.j = rnd();
  for (int i = 0; i < 100; i++) {
    s2 = s1; s2.a += i; s2.h -= i; s2.i ^= i;
    h = mix(h, s2.a + s2.b + s2.c + s2.d + s2.e + s2.f + s2.g + s2.h + s2.i + s2.j);
    s1 = s2; s1.g = mix(s1.g, s2.a);
  }
  h = mix(h, fib(20));
  fn tab[3] = { f1, f2, f3 };
  for (int i = 0; i < 1000; i++) { u32 r = rnd(); h = mix(h, sw(r)); h = mix(h, tab[r % 3](r)); }
  results[4] = h;
}

#ifdef NATIVE
int main(void) { tests(); for (int i = 0; i < 5; i++) printf("%08x\n", results[i]); return 0; }
#else
int main(void) {
  tests();
  volatile u32 *out = (u32 *)0x02000000;
  for (int i = 0; i < 5; i++) out[i] = results[i];
  out[15] = 0xDEADBEEF;
  for (;;) {}
}
#endif
