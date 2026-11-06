    .syntax unified
    .arm
    .section .iwram, "ax"
    .global irq_handler
irq_handler:
    mov r3, #0x04000000
    add r3, r3, #0x200
    ldrh r1, [r3]
    ldrh r2, [r3, #2]
    and r1, r1, r2
    strh r1, [r3, #2]
    ldr r2, =0x03007FF8
    ldrh r0, [r2]
    orr r0, r0, r1
    strh r0, [r2]
    ldr r2, =irq_flags_seen
    ldr r0, [r2]
    orr r0, r0, r1
    str r0, [r2]
    tst r1, #1
    ldrne r2, =vbl_count
    ldrne r0, [r2]
    addne r0, r0, #1
    strne r0, [r2]
    tst r1, #8
    ldrne r2, =tm_count
    ldrne r0, [r2]
    addne r0, r0, #1
    strne r0, [r2]
    bx lr
    .ltorg
