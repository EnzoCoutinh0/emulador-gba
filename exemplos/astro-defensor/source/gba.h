// gba.h — definições mínimas do hardware do Game Boy Advance (sem bibliotecas externas)
#pragma once
typedef unsigned char u8;   typedef signed char s8;
typedef unsigned short u16; typedef signed short s16;
typedef unsigned int u32;   typedef signed int s32;
typedef volatile u8 vu8; typedef volatile u16 vu16; typedef volatile u32 vu32;

#define REG16(a) (*(vu16 *)(a))
#define REG32(a) (*(vu32 *)(a))

// ---- vídeo ----
#define REG_DISPCNT   REG16(0x04000000)
#define REG_DISPSTAT  REG16(0x04000004)
#define REG_VCOUNT    REG16(0x04000006)
#define REG_BGCNT(n)  REG16(0x04000008 + (n) * 2)
#define REG_BGHOFS(n) REG16(0x04000010 + (n) * 4)
#define REG_BGVOFS(n) REG16(0x04000012 + (n) * 4)
#define REG_BLDCNT    REG16(0x04000050)
#define REG_BLDALPHA  REG16(0x04000052)
#define REG_BLDY      REG16(0x04000054)
#define DCNT_MODE0  0x0000
#define DCNT_OBJ_1D 0x0040
#define DCNT_BG0    0x0100
#define DCNT_BG1    0x0200
#define DCNT_BG2    0x0400
#define DCNT_OBJ    0x1000

#define PAL_BG   ((vu16 *)0x05000000)
#define PAL_OBJ  ((vu16 *)0x05000200)
#define VRAM     ((vu16 *)0x06000000)
#define CHARBLOCK(n)   ((vu32 *)(0x06000000 + (n) * 0x4000))
#define SCREENBLOCK(n) ((vu16 *)(0x06000000 + (n) * 0x800))
#define OBJ_TILES ((vu32 *)0x06010000)
#define OAM      ((vu16 *)0x07000000)

// atributos de sprite
#define ATTR0_HIDE   0x0200
#define ATTR0_SQUARE 0x0000
#define ATTR1_SIZE8  0x0000
#define ATTR1_SIZE16 0x4000
#define ATTR1_HFLIP  0x1000

// ---- entrada ----
#define REG_KEYINPUT REG16(0x04000130)
#define KEY_A      0x0001
#define KEY_B      0x0002
#define KEY_SELECT 0x0004
#define KEY_START  0x0008
#define KEY_RIGHT  0x0010
#define KEY_LEFT   0x0020
#define KEY_UP     0x0040
#define KEY_DOWN   0x0080
#define KEY_R      0x0100
#define KEY_L      0x0200

// ---- interrupções ----
#define REG_IE  REG16(0x04000200)
#define REG_IF  REG16(0x04000202)
#define REG_IME REG16(0x04000208)
#define IRQ_HANDLER REG32(0x03007FFC)

// ---- som ----
#define REG_SND1SWEEP REG16(0x04000060)
#define REG_SND1CNT   REG16(0x04000062)
#define REG_SND1FREQ  REG16(0x04000064)
#define REG_SND2CNT   REG16(0x04000068)
#define REG_SND2FREQ  REG16(0x0400006C)
#define REG_SND3SEL   REG16(0x04000070)
#define REG_SND3CNT   REG16(0x04000072)
#define REG_SND3FREQ  REG16(0x04000074)
#define REG_SND4CNT   REG16(0x04000078)
#define REG_SND4FREQ  REG16(0x0400007C)
#define REG_SNDDMGCNT REG16(0x04000080)
#define REG_SNDDSCNT  REG16(0x04000082)
#define REG_SNDSTAT   REG16(0x04000084)
#define WAVE_RAM      ((vu16 *)0x04000090)

// ---- save (SRAM de 32 KB, acesso de 8 bits) ----
#define SRAM ((vu8 *)0x0E000000)

// espera o próximo VBlank pela BIOS (SWI 5): economiza bateria e sincroniza com a tela
static inline void vblank_wait(void) { __asm__ volatile("svc 5" ::: "r0", "r1", "r2", "r3", "memory"); }
