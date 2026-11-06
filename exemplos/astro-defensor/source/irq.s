@ Tratador de interrupção (em modo ARM, na RAM rápida).
@ Confirma as interrupções e avisa a BIOS (0x03007FF8) para o VBlankIntrWait funcionar.
    .syntax unified
    .arm
    .section .iwram, "ax"
    .global irq_handler
irq_handler:
    mov r3, #0x04000000
    add r3, r3, #0x200
    ldrh r1, [r3]           @ IE
    ldrh r2, [r3, #2]       @ IF
    and r1, r1, r2
    strh r1, [r3, #2]       @ confirma (escrever 1 apaga o pedido)
    ldr r2, =0x03007FF8
    ldrh r0, [r2]
    orr r0, r0, r1
    strh r0, [r2]
    bx lr
    .ltorg
