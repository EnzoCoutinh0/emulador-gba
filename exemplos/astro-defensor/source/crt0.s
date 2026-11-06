    .section .text.start, "ax"
    .arm
    .global _start
_start:
    b start
    .fill 188, 1, 0
start:
    mov r0, #0x12          @ modo IRQ
    msr cpsr_c, r0
    ldr sp, =0x03007FA0
    mov r0, #0x1F          @ modo System
    msr cpsr_c, r0
    ldr sp, =0x03007F00
    @ copia .data
    ldr r0, =__data_lma
    ldr r1, =__data_start
    ldr r2, =__data_end
1:  cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo 1b
    @ zera .bss
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
2:  cmp r1, r2
    strlo r3, [r1], #4
    blo 2b
    ldr r0, =main
    mov lr, pc
    bx r0
3:  b 3b
    .ltorg
