// Pequenas funções que o compilador espera de uma biblioteca C (não usamos nenhuma).
// Divisão inteira: o processador do GBA não tem instrução de divisão.
typedef unsigned int u32; typedef int s32; typedef unsigned long long u64;
u32 __aeabi_uidiv(u32 n, u32 d) {
  u32 q = 0, r = 0;
  for (int i = 31; i >= 0; i--) { r = (r << 1) | ((n >> i) & 1); if (r >= d) { r -= d; q |= 1u << i; } }
  return q;
}
s32 __aeabi_idiv(s32 n, s32 d) {
  int neg = (n < 0) ^ (d < 0);
  u32 q = __aeabi_uidiv(n < 0 ? -(u32)n : (u32)n, d < 0 ? -(u32)d : (u32)d);
  return neg ? -(s32)q : (s32)q;
}
u64 __aeabi_uidivmod(u32 n, u32 d) { u32 q = __aeabi_uidiv(n, d); return ((u64)(n - q * d) << 32) | q; }
