    .arm
    .text
    .global __aeabi_lmul
__aeabi_lmul:            @ (r1:r0) * (r3:r2)
    push {r4, lr}
    mul r4, r0, r3
    mla r4, r1, r2, r4
    umull r0, r1, r2, r0
    add r1, r1, r4
    pop {r4, lr}
    bx lr
    .global __aeabi_llsl
__aeabi_llsl:
    subs r3, r2, #32
    movpl r1, r0, lsl r3
    movpl r0, #0
    bxpl lr
    rsb r3, r2, #32
    mov r1, r1, lsl r2
    orr r1, r1, r0, lsr r3
    mov r0, r0, lsl r2
    bx lr
    .global __aeabi_llsr
__aeabi_llsr:
    subs r3, r2, #32
    movpl r0, r1, lsr r3
    movpl r1, #0
    bxpl lr
    rsb r3, r2, #32
    mov r0, r0, lsr r2
    orr r0, r0, r1, lsl r3
    mov r1, r1, lsr r2
    bx lr
    .global __aeabi_lasr
__aeabi_lasr:
    subs r3, r2, #32
    movpl r0, r1, asr r3
    movpl r1, r1, asr #31
    bxpl lr
    rsb r3, r2, #32
    mov r0, r0, lsr r2
    orr r0, r0, r1, lsl r3
    mov r1, r1, asr r2
    bx lr
