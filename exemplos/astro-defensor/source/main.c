// =====================================================================
// ASTRO DEFENSOR — um jogo de nave para Game Boy Advance, feito do zero
// =====================================================================
// Controles: direcional move, A atira (segure para tiro contínuo),
//            START começa e pausa.
// Telas: título -> jogo -> fim de jogo -> título.
// O recorde fica salvo na SRAM do cartucho.
// =====================================================================
#include "gba.h"
#include "gfx.h"

// Etiqueta para o emulador (e os flashcarts) saberem que o jogo usa SRAM.
__attribute__((used, aligned(4))) const char save_tag[] = "SRAM_V113";

void *memcpy(void *d, const void *s, u32 n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, u32 n) { u8 *a = d; while (n--) *a++ = (u8)c; return d; }
extern void irq_handler(void);

// Posições em ponto fixo: 8 bits de fração (FX(1) = 1 pixel = 256).
#define FX(v) ((v) << 8)
#define PX(v) ((v) >> 8)

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
static u32 rng = 0x1234567;
static u32 rnd(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
static int rnd_range(int n) { return (int)(((rnd() & 0xFFFF) * (u32)n) >> 16); } // 0..n-1, sem divisão

static u16 oam_buf[128 * 4];   // cópia da OAM, enviada no VBlank
static void spr(int i, int x, int y, int tile, int big, int pal) {
  u16 *o = &oam_buf[i * 4];
  o[0] = (y & 0xFF) | ATTR0_SQUARE;
  o[1] = (x & 0x1FF) | (big ? ATTR1_SIZE16 : ATTR1_SIZE8);
  o[2] = tile | (1 << 10) | (pal << 12);
}
static void spr_hide(int i) { oam_buf[i * 4] = ATTR0_HIDE; }

// ---- texto no fundo BG0 (screenblock 31) ----
static vu16 *const txt = SCREENBLOCK(31);
static int glyph(char c) {
  for (int i = 0; font_order[i]; i++) if (font_order[i] == c) return i;
  return 0;
}
static void text(int x, int y, const char *s, int pal) {
  for (; *s; s++, x++) if (x < 30) txt[y * 32 + x] = glyph(*s) | (pal << 12);
}
static void text_clear_row(int y) { for (int x = 0; x < 32; x++) txt[y * 32 + x] = 0; }
static void text_clear(void) { for (int i = 0; i < 32 * 20; i++) txt[i] = 0; }
static void text_center(int y, const char *s, int pal) {
  int n = 0; while (s[n]) n++;
  text((30 - n) / 2, y, s, pal);
}
// número com 6 dígitos (sem usar divisão)
static void num6(char *out, u32 v) {
  static const u32 pw[6] = { 100000, 10000, 1000, 100, 10, 1 };
  for (int i = 0; i < 6; i++) { char d = '0'; while (v >= pw[i]) { v -= pw[i]; d++; } out[i] = d; }
  out[6] = 0;
}

// ---------------------------------------------------------------------
// Som: canal 1 = laser, canal 2 = efeitos, canal 3 = música, canal 4 = explosões
// ---------------------------------------------------------------------
static int music_on = 1, music_pos = 0, music_t = 0, sfx2_t = 0, sfx2_next = 0;
static void sound_init(void) {
  REG_SNDSTAT = 0x80;                 // liga o som
  REG_SNDDMGCNT = 0xFF77;             // todos os canais nos dois lados, volume máximo
  REG_SNDDSCNT = 0x0002;              // canais clássicos em 100%
  REG_SND3SEL = 0x40;                 // grava no banco 0 da onda
  for (int i = 0; i < 8; i++) WAVE_RAM[i] = wave_data[i * 2] | (wave_data[i * 2 + 1] << 8);
  REG_SND3SEL = 0x80;                 // liga o canal 3 tocando o banco 0
}
static void sfx_laser(void) { REG_SND1SWEEP = 0x001A; REG_SND1CNT = 0x8180; REG_SND1FREQ = 0x8000 | 1780; }
static void sfx_boom(int big) { REG_SND4CNT = big ? 0xF500 : 0xC300; REG_SND4FREQ = 0x8000 | (big ? 0x63 : 0x52); }
static void sfx_power(void) { REG_SND2CNT = 0xB280; REG_SND2FREQ = 0x8000 | 1840; sfx2_t = 6; sfx2_next = 1930; }
static void sfx_turret(void) { REG_SND2CNT = 0x6180; REG_SND2FREQ = 0x8000 | 1400; sfx2_t = 0; }
static void sound_tick(void) {
  if (sfx2_t && --sfx2_t == 0 && sfx2_next) { REG_SND2CNT = 0xB280; REG_SND2FREQ = 0x8000 | sfx2_next; sfx2_next = 0; }
  if (!music_on) { REG_SND3CNT = 0; return; }
  if (music_t-- > 0) return;
  music_t = 7;                        // um passo da melodia a cada 8 quadros
  u16 f = melody[music_pos];
  if (++music_pos >= MELODY_LEN) music_pos = 0;
  if (f) { REG_SND3CNT = 0x4000; REG_SND3FREQ = 0x8000 | f; }   // volume 50%
  else REG_SND3CNT = 0;
}

// ---------------------------------------------------------------------
// Recorde salvo na SRAM: "ASTR" + 4 bytes
// ---------------------------------------------------------------------
static u32 hiscore;
static void load_hiscore(void) {
  if (SRAM[0] == 'A' && SRAM[1] == 'S' && SRAM[2] == 'T' && SRAM[3] == 'R')
    hiscore = SRAM[4] | (SRAM[5] << 8) | (SRAM[6] << 16) | ((u32)SRAM[7] << 24);
  else hiscore = 0;
}
static void save_hiscore(void) {
  SRAM[0] = 'A'; SRAM[1] = 'S'; SRAM[2] = 'T'; SRAM[3] = 'R';
  SRAM[4] = hiscore; SRAM[5] = hiscore >> 8; SRAM[6] = hiscore >> 16; SRAM[7] = hiscore >> 24;
}

// ---------------------------------------------------------------------
// Objetos do jogo
// ---------------------------------------------------------------------
#define MAX_PB 12   // tiros do jogador
#define MAX_EN 10   // inimigos
#define MAX_EB 16   // tiros inimigos
#define MAX_EX 8    // explosões
// índices na OAM
#define OAM_PLAYER 0
#define OAM_PB 1
#define OAM_EN (OAM_PB + MAX_PB)
#define OAM_EB (OAM_EN + MAX_EN)
#define OAM_EX (OAM_EB + MAX_EB)
#define OAM_POW (OAM_EX + MAX_EX)

enum { EN_SAUCER, EN_BUG, EN_TURRET };
typedef struct { s32 x, y, vx, vy; s16 base; u8 on, type, hp, flash; u16 t; } Obj;

static Obj pb[MAX_PB], en[MAX_EN], eb[MAX_EB], ex[MAX_EX], pw;
static s32 plx, ply;
static int lives, inv, power, cooldown, dead_t, level, level_msg, spawn_t;
static u32 score, next_level;
static int new_record;
enum { ST_TITLE, ST_PLAY, ST_PAUSE, ST_OVER };
static int state;
static u32 frame;
static u16 keys, prev;
#define HIT(k) ((keys & (k)) && !(prev & (k)))   // acabou de apertar

static int overlap(int ax, int ay, int aw, int ah, int bx, int by, int bw, int bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

static void explode(s32 x, s32 y, int big) {
  for (int i = 0; i < MAX_EX; i++) if (!ex[i].on) { ex[i].on = 1; ex[i].x = x; ex[i].y = y; ex[i].t = 0; break; }
  sfx_boom(big);
}

static void hud(void) {
  char b[8];
  text(1, 0, "PTS", 0); num6(b, score); text(5, 0, b, 0);
  text(13, 0, "VIDAS", 0); char l[2] = { (char)('0' + (lives > 9 ? 9 : lives)), 0 }; text(19, 0, l, 0);
  text(22, 0, "NIVEL", 0); char n[2] = { (char)('0' + (level > 9 ? 9 : level)), 0 }; text(28, 0, n, 0);
}

static void clear_objects(void) {
  memset(pb, 0, sizeof pb); memset(en, 0, sizeof en); memset(eb, 0, sizeof eb); memset(ex, 0, sizeof ex); memset(&pw, 0, sizeof pw);
  for (int i = 0; i < 128; i++) spr_hide(i);
}

static void title_screen(void) {
  state = ST_TITLE; music_on = 1;
  clear_objects(); text_clear();
  text_center(4, "A S T R O", 1);
  text_center(6, "D E F E N S O R", 1);
  char b[8]; num6(b, hiscore);
  text(9, 13, "RECORDE", 0); text(17, 13, b, 0);
  text_center(16, "A: ATIRA   START: PAUSA", 0);
  text_center(18, "FEITO DO ZERO PARA GBA", 0);
}

static void start_game(void) {
  state = ST_PLAY; music_on = 1;
  clear_objects(); text_clear();
  plx = FX(24); ply = FX(72);
  lives = 3; inv = 90; power = 0; cooldown = 0; dead_t = 0;
  score = 0; level = 1; next_level = 2000; level_msg = 90; spawn_t = 60; new_record = 0;
  hud();
}

static void game_over(void) {
  state = ST_OVER;
  if (score > hiscore) { hiscore = score; save_hiscore(); new_record = 1; }
  text_center(8, "FIM DE JOGO", 1);
  if (new_record) text_center(10, "NOVO RECORDE!", 1);
  char b[8]; num6(b, score); text(9, 12, "PONTOS", 0); text(16, 12, b, 0);
}

static void spawn_enemy(void) {
  int i; for (i = 0; i < MAX_EN && en[i].on; i++) {} if (i == MAX_EN) return;
  Obj *e = &en[i];
  int r = rnd_range(100);
  e->type = (level >= 3 && r < 18) ? EN_TURRET : (level >= 2 && r < 55) ? EN_BUG : (r < 40 ? EN_BUG : EN_SAUCER);
  e->on = 1; e->t = 0; e->flash = 0;
  e->x = FX(244); e->y = FX(16 + rnd_range(128)); e->base = PX(e->y);
  e->vy = 0;
  switch (e->type) {
    case EN_SAUCER: e->hp = 1; e->vx = -(320 + rnd_range(96) + level * 24); break;
    case EN_BUG:    e->hp = 1; e->vx = -(260 + level * 20); if (e->base < 40) e->base = 40; if (e->base > 120) e->base = 120; break;
    default:        e->hp = 4; e->vx = -256; break;
  }
}

static void enemy_shoot(Obj *e) {
  int i; for (i = 0; i < MAX_EB && eb[i].on; i++) {} if (i == MAX_EB) return;
  // mira na nave: vetor normalizado aproximado (sem divisão nem raiz)
  s32 dx = PX(plx) - PX(e->x), dy = PX(ply) - PX(e->y);
  s32 ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
  s32 m = ax > ay ? ax + (ay >> 1) : ay + (ax >> 1);  // ~ comprimento
  if (m < 1) m = 1;
  s32 speed = 400 + level * 30;
  // vx = dx * speed / m, feito por subtrações sucessivas (m é pequeno)
  s32 vx = 0, vy = 0, nx = dx * speed, ny = dy * speed;
  s32 sx = nx < 0 ? -1 : 1, sy = ny < 0 ? -1 : 1; nx *= sx; ny *= sy;
  s32 step = m << 6; while (nx >= step) { nx -= step; vx += 64; } while (nx >= m) { nx -= m; vx++; }
  step = m << 6; while (ny >= step) { ny -= step; vy += 64; } while (ny >= m) { ny -= m; vy++; }
  eb[i].on = 1; eb[i].x = e->x + FX(4); eb[i].y = e->y + FX(4); eb[i].vx = vx * sx; eb[i].vy = vy * sy;
  sfx_turret();
}

static void player_hit(void) {
  explode(plx, ply, 1);
  lives--; inv = 120; power = 0;
  if (lives <= 0) { dead_t = 70; }
  hud();
}

static void add_score(int v) {
  score += v;
  if (score >= next_level) { level++; next_level += 2000 + level * 500; level_msg = 90; }
  hud();
}

static void update_play(void) {
  // ---- nave ----
  if (!dead_t) {
    s32 sp = FX(2);
    if (keys & KEY_LEFT) plx -= sp;
    if (keys & KEY_RIGHT) plx += sp;
    if (keys & KEY_UP) ply -= sp;
    if (keys & KEY_DOWN) ply += sp;
    if (plx < FX(0)) plx = FX(0); if (plx > FX(224)) plx = FX(224);
    if (ply < FX(10)) ply = FX(10); if (ply > FX(144)) ply = FX(144);
    if (cooldown) cooldown--;
    if ((keys & KEY_A) && !cooldown) {
      cooldown = 9;
      int shots = power ? 2 : 1;
      for (int s = 0; s < shots; s++) {
        int i; for (i = 0; i < MAX_PB && pb[i].on; i++) {} if (i == MAX_PB) break;
        pb[i].on = 1; pb[i].x = plx + FX(10); pb[i].y = ply + FX(4) + (power ? (s ? FX(4) : -FX(4)) : 0);
      }
      sfx_laser();
    }
    if (inv) inv--;
    if (power) power--;
  } else if (--dead_t == 0) { game_over(); return; }

  // ---- tiros do jogador ----
  for (int i = 0; i < MAX_PB; i++) if (pb[i].on) { pb[i].x += FX(5); if (pb[i].x > FX(240)) pb[i].on = 0; }

  // ---- inimigos ----
  if (--spawn_t <= 0) { spawn_enemy(); int base = 70 - level * 6; if (base < 22) base = 22; spawn_t = base + rnd_range(30); }
  for (int i = 0; i < MAX_EN; i++) {
    Obj *e = &en[i]; if (!e->on) continue;
    e->t++;
    if (e->flash) e->flash--;
    if (e->type == EN_BUG) e->y = FX(e->base + sine_tab[(e->t * 2) & 63]);
    if (e->type == EN_TURRET) {
      if (e->x <= FX(188) && e->vx == -256) e->vx = 0;           // para e começa a atirar
      if (e->vx == 0 && (e->t & 63) == 0) { enemy_shoot(e); if (e->t > 64 * 6) e->vx = -384; }
    }
    e->x += e->vx;
    if (e->x < -FX(20)) e->on = 0;
    // colisão com os tiros
    int exx = PX(e->x), eyy = PX(e->y);
    for (int j = 0; j < MAX_PB && e->on; j++) {
      if (!pb[j].on) continue;
      if (overlap(PX(pb[j].x) + 1, PX(pb[j].y) + 3, 7, 2, exx + 2, eyy + 3, 12, 10)) {
        pb[j].on = 0;
        if (--e->hp == 0) {
          e->on = 0; explode(e->x, e->y, e->type == EN_TURRET);
          add_score(e->type == EN_SAUCER ? 100 : e->type == EN_BUG ? 150 : 300);
          if (!pw.on && rnd_range(100) < 9) { pw.on = 1; pw.x = e->x; pw.y = e->y; }
        } else { e->flash = 6; sfx_boom(0); }
      }
    }
    // colisão com a nave
    if (e->on && !inv && !dead_t && overlap(PX(plx) + 3, PX(ply) + 5, 10, 6, exx + 2, eyy + 3, 12, 10)) {
      e->on = 0; explode(e->x, e->y, 0); player_hit();
    }
  }
  // ---- tiros inimigos ----
  for (int i = 0; i < MAX_EB; i++) {
    Obj *b = &eb[i]; if (!b->on) continue;
    b->x += b->vx; b->y += b->vy;
    if (b->x < -FX(8) || b->x > FX(240) || b->y < -FX(8) || b->y > FX(160)) { b->on = 0; continue; }
    if (!inv && !dead_t && overlap(PX(plx) + 3, PX(ply) + 5, 10, 6, PX(b->x) + 2, PX(b->y) + 2, 4, 4)) { b->on = 0; player_hit(); }
  }
  // ---- power-up ----
  if (pw.on) {
    pw.x -= 200; pw.t++;
    pw.y += (pw.t & 32) ? 64 : -64;
    if (pw.x < -FX(16)) pw.on = 0;
    else if (!dead_t && overlap(PX(plx), PX(ply), 16, 16, PX(pw.x) + 2, PX(pw.y) + 2, 12, 12)) { pw.on = 0; power = 600; sfx_power(); add_score(50); }
  }
  // ---- mensagens ----
  if (level_msg) {
    if (level_msg == 90) { char m[9] = "NIVEL  "; m[6] = (char)('0' + (level > 9 ? 9 : level)); text_center(9, m, 1); }
    if (--level_msg == 0) text_clear_row(9);
  }
}

static void update_explosions(void) {
  for (int i = 0; i < MAX_EX; i++) if (ex[i].on && ++ex[i].t >= 32) ex[i].on = 0;
}

static void draw(void) {
  // nave (pisca quando invencível; some quando destruída)
  if (state == ST_PLAY || state == ST_PAUSE) {
    if (dead_t || ((inv >> 2) & 1)) spr_hide(OAM_PLAYER);
    else spr(OAM_PLAYER, PX(plx), PX(ply), (frame & 4) ? T_SHIP1 : T_SHIP0, 1, 0);
  } else if (state == ST_TITLE) {
    spr(OAM_PLAYER, 104 + (sine_tab[(frame >> 1) & 63] >> 1), 84 + (sine_tab[(frame + 16) & 63] >> 2), (frame & 4) ? T_SHIP1 : T_SHIP0, 1, 0);
  } else spr_hide(OAM_PLAYER);
  for (int i = 0; i < MAX_PB; i++) if (pb[i].on) spr(OAM_PB + i, PX(pb[i].x), PX(pb[i].y), T_LASER, 0, 0); else spr_hide(OAM_PB + i);
  for (int i = 0; i < MAX_EN; i++) {
    Obj *e = &en[i];
    if (!e->on || (e->flash & 2)) { spr_hide(OAM_EN + i); continue; }
    int t = e->type == EN_SAUCER ? ((e->t & 8) ? T_SAUCER1 : T_SAUCER0) : e->type == EN_BUG ? ((e->t & 8) ? T_BUG1 : T_BUG0) : T_TURRET;
    spr(OAM_EN + i, PX(e->x), PX(e->y), t, 1, 0);
  }
  for (int i = 0; i < MAX_EB; i++) if (eb[i].on) spr(OAM_EB + i, PX(eb[i].x), PX(eb[i].y), T_EBULLET, 0, 0); else spr_hide(OAM_EB + i);
  for (int i = 0; i < MAX_EX; i++) if (ex[i].on) spr(OAM_EX + i, PX(ex[i].x), PX(ex[i].y), T_EXPL0 + (ex[i].t >> 3) * 4, 1, 0); else spr_hide(OAM_EX + i);
  if (pw.on) spr(OAM_POW, PX(pw.x), PX(pw.y), T_POWER, 1, 0); else spr_hide(OAM_POW);
}

// ---------------------------------------------------------------------
// Inicialização do vídeo
// ---------------------------------------------------------------------
static void video_init(void) {
  REG_DISPCNT = 0x0080;   // tela branca (forced blank) enquanto carrega
  for (int i = 0; i < 32; i++) PAL_BG[i] = bg_pal[i];
  for (int i = 0; i < 16; i++) PAL_OBJ[i] = obj_pal[i];
  vu32 *cb = CHARBLOCK(0);
  for (u32 i = 0; i < sizeof font_tiles / 4; i++) cb[i] = font_tiles[i];
  for (u32 i = 0; i < sizeof star_tiles / 4; i++) cb[STAR_TILE0 * 8 + i] = star_tiles[i];
  for (u32 i = 0; i < sizeof obj_tiles / 4; i++) OBJ_TILES[i] = obj_tiles[i];
  // estrelas: BG1 (distantes, lentas) e BG2 (próximas, rápidas)
  vu16 *far = SCREENBLOCK(30), *near = SCREENBLOCK(29);
  for (int i = 0; i < 1024; i++) {
    int r = rnd_range(100);
    far[i] = r < 9 ? STAR_TILE0 + (r < 6 ? 0 : 1) : 0;
    int q = rnd_range(100);
    near[i] = q < 4 ? STAR_TILE0 + (q < 3 ? 2 : 3) : 0;
  }
  text_clear();
  REG_BGCNT(0) = (31 << 8) | 0;      // texto: prioridade 0 (na frente)
  REG_BGCNT(1) = (30 << 8) | 3;      // estrelas distantes: prioridade 3
  REG_BGCNT(2) = (29 << 8) | 2;      // estrelas próximas: prioridade 2
  for (int i = 0; i < 128; i++) spr_hide(i);
}

int main(void) {
  IRQ_HANDLER = (u32)irq_handler;
  REG_DISPSTAT = 0x0008;   // pede interrupção no VBlank
  REG_IE = 0x0001; REG_IME = 1;
  video_init();
  sound_init();
  load_hiscore();
  title_screen();
  REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_BG2 | DCNT_OBJ | DCNT_OBJ_1D;
  u32 scroll_far = 0, scroll_near = 0;
  for (;;) {
    vblank_wait();
    // ---- durante o VBlank: atualiza sprites e rolagem ----
    for (int i = 0; i < 128 * 4; i++) OAM[i] = oam_buf[i];
    if (state != ST_PAUSE) { scroll_far += 96; scroll_near += 400; }
    REG_BGHOFS(1) = scroll_far >> 8; REG_BGHOFS(2) = scroll_near >> 8;
    sound_tick();
    // ---- lógica ----
    prev = keys; keys = ~REG_KEYINPUT & 0x3FF;
    frame++;
    switch (state) {
      case ST_TITLE:
        rnd();   // o tempo até apertar START embaralha a sorte
        if ((frame & 31) == 0) text_center(11, "PRESSIONE START", 0);
        if ((frame & 31) == 16) text_clear_row(11);
        if (HIT(KEY_START) || HIT(KEY_A)) start_game();
        break;
      case ST_PLAY:
        if (HIT(KEY_START) && !dead_t) { state = ST_PAUSE; music_on = 0; text_center(9, "PAUSADO", 1); break; }
        update_play(); update_explosions();
        break;
      case ST_PAUSE:
        if (HIT(KEY_START)) { state = ST_PLAY; music_on = 1; text_clear_row(9); }
        break;
      case ST_OVER:
        update_explosions();
        for (int i = 0; i < MAX_EN; i++) if (en[i].on) { en[i].x += en[i].vx; if (en[i].x < -FX(20)) en[i].on = 0; }
        for (int i = 0; i < MAX_EB; i++) eb[i].on = 0;
        if ((frame & 31) == 0) text_center(15, "PRESSIONE START", 0);
        if ((frame & 31) == 16) text_clear_row(15);
        if (HIT(KEY_START)) title_screen();
        break;
    }
    draw();
  }
}
