.syntax unified
    .arm
    .text
    .global main
main:
    ldr r12, =0x02000000
    @ 0: adds com carry -> flags
    mvn r0, #0
    adds r0, r0, #1
    mrs r1, cpsr
    and r1, r1, #0xF0000000
    str r1, [r12, #0]          @ esperado 0x60000000 (Z,C)
    @ 1: overflow
    mvn r0, #0x80000000
    adds r0, r0, #1
    mrs r1, cpsr
    and r1, r1, #0xF0000000
    str r1, [r12, #4]          @ esperado 0x90000000 (N,V)
    @ 2: rrx com C=1
    msr cpsr_f, #0x20000000
    mov r0, #2
    movs r1, r0, rrx
    str r1, [r12, #8]          @ 0x80000001
    @ 3: lsl por registro = 32 => 0, C = bit0
    mov r0, #3
    mov r2, #32
    movs r1, r0, lsl r2
    mrs r1, cpsr
    and r1, r1, #0xF0000000
    str r1, [r12, #12]         @ 0x60000000
    @ 4: ldr desalinhado
    ldr r0, =0x11223344
    ldr r2, =0x02001000
    str r0, [r2]
    ldr r1, [r2, #1]
    str r1, [r12, #16]         @ 0x44112233
    @ 5: ldrh desalinhado
    ldrh r1, [r2, #1]
    str r1, [r12, #20]         @ 0x44000033
    @ 6: ldrsh desalinhado = ldrsb
    mov r3, #1
    ldrsh r1, [r2, r3]
    str r1, [r12, #24]         @ 0x00000033
    @ 7: bancos de registradores
    ldr sp, =0x03007F00
    mov r0, #0xD2              @ IRQ, I=1
    msr cpsr_c, r0
    ldr sp, =0x12345678
    mov r0, #0xDF
    msr cpsr_c, r0
    str sp, [r12, #28]         @ 0x03007F00
    mov r0, #0xD2
    msr cpsr_c, r0
    str sp, [r12, #32]         @ 0x12345678
    ldr r0, =0xF00000DF
    msr spsr_fsxc, r0
    mrs r1, spsr
    str r1, [r12, #36]         @ 0xF00000DF
    mov r0, #0xDF
    msr cpsr_c, r0
    @ 8: swp
    ldr r0, =0xAABBCCDD
    str r0, [r2]
    ldr r1, =0x55
    swp r3, r1, [r2]
    ldr r4, [r2]
    add r3, r3, r4
    str r3, [r12, #40]         @ 0xAABBCD32
    @ 9: stm com base na lista (não primeira) e writeback
    ldr r1, =0x02001100
    mov r0, #7
    stmia r1!, {r0, r1}
    ldr r3, =0x02001104
    ldr r3, [r3]
    str r3, [r12, #44]         @ 0x02001108
    @ 10: sbcs/rscs
    msr cpsr_f, #0             @ C=0
    mov r0, #5
    sbcs r1, r0, #5            @ 5-5-1 = -1, C=0
    mrs r3, cpsr
    and r3, r3, #0xF0000000
    orr r3, r3, r1, lsr #28
    str r3, [r12, #48]         @ 0x8000000F
    @ 11: asr por registro >= 32
    ldr r0, =0x80000000
    mov r2, #40
    movs r1, r0, asr r2
    mrs r3, cpsr
    and r3, r3, #0xF0000000
    eor r3, r3, r1
    str r3, [r12, #52]         @ 0xFFFFFFFF ^ 0xA0000000 = 0x5FFFFFFF
    @ 12: umlal / smull
    ldr r0, =0xFFFFFFFF
    ldr r1, =0xFFFFFFFF
    mov r2, #1
    mov r3, #0
    umlal r2, r3, r0, r1        @ 0xFFFFFFFE00000001 + 1 = 0xFFFFFFFE00000002
    str r2, [r12, #56]          @ 2
    str r3, [r12, #60-4]        @ placeholder
    smull r4, r5, r0, r1        @ (-1)*(-1) = 1
    add r5, r5, r3
    str r5, [r12, #64]          @ 0xFFFFFFFE
    str r4, [r12, #68]          @ 1
    @ 13: thumb via bx + bl
    adr r0, thumbcode + 1
    mov lr, pc
    bx r0
    str r0, [r12, #72]          @ 0x1234 + 5 = 0x1239
    ldr r0, =0xDEADBEEF
    str r0, [r12, #60]
1:  b 1b
    .thumb
    .thumb_func
thumbcode:
    push {lr}
    ldr r0, =0x1234
    bl tsub
    pop {r1}
    bx r1
    .thumb_func
tsub:
    adds r0, #5
    bx lr
    .ltorg
