#ifdef __APPLE__
#define CNAME(x) _ ## x
#else
#define CNAME(x) x
#endif
.text

/* x0: vector results, x1: memory, x2: initial vectors, x3: base delta. */
.macro lane_probe name, opcode, mode
.p2align 2
.globl \name
\name:
    mov x9, x1
    mov x10, #13
    ldp q0, q1, [x2]
    ldp q2, q3, [x2, #32]
    ldp q30, q31, [x2, #64]
    .inst \opcode
    stp q0, q1, [x0]
    stp q2, q3, [x0, #32]
    stp q30, q31, [x0, #64]
    sub x9, x9, x1
    str x9, [x3]
    ret
.endm

#define LANE_CASE(name, opcode, load, count, width, lane, mode, rt, invalid) \
    lane_probe CNAME(name), opcode, mode
#include "regress_simd_lane_cases.inc"
#undef LANE_CASE
