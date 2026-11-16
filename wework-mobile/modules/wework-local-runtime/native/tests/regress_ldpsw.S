#ifdef __APPLE__
#define CNAME(x) _ ## x
#else
#define CNAME(x) x
#endif
.text
.p2align 2
.globl CNAME(ldpsw_offset_zero)
CNAME(ldpsw_offset_zero):
add x8, x1, #0
ldpsw x2, x3, [x8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_offset_positive)
CNAME(ldpsw_offset_positive):
add x8, x1, #0
ldpsw x2, x3, [x8, #8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_offset_negative)
CNAME(ldpsw_offset_negative):
add x8, x1, #8
ldpsw x2, x3, [x8, #-8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_pre_positive)
CNAME(ldpsw_pre_positive):
add x8, x1, #0
ldpsw x2, x3, [x8, #8]!
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_pre_negative)
CNAME(ldpsw_pre_negative):
add x8, x1, #8
ldpsw x2, x3, [x8, #-8]!
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_post_positive)
CNAME(ldpsw_post_positive):
add x8, x1, #0
ldpsw x2, x3, [x8], #8
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_post_negative)
CNAME(ldpsw_post_negative):
add x8, x1, #8
ldpsw x2, x3, [x8], #-8
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_offset_nonnegative)
CNAME(ldpsw_offset_nonnegative):
add x8, x1, #16
ldpsw x2, x3, [x8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_zero_first)
CNAME(ldpsw_zero_first):
add x8, x1, #16
mov x2, #12345
ldpsw xzr, x3, [x8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_zero_second)
CNAME(ldpsw_zero_second):
mov x8, x1
mov x3, #12345
ldpsw x2, xzr, [x8]
stp x2, x3, [x0]
sub x4, x8, x1
str x4, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_base_alias_first)
CNAME(ldpsw_base_alias_first):
mov x8, x1
ldpsw x8, x3, [x8]
stp x8, x3, [x0]
str xzr, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_base_alias_second)
CNAME(ldpsw_base_alias_second):
mov x8, x1
ldpsw x2, x8, [x8]
stp x2, x8, [x0]
str xzr, [x0, #16]
ret
.p2align 2
.globl CNAME(ldpsw_sp_offset)
CNAME(ldpsw_sp_offset):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #16
mov x9, sp
ldpsw x2, x3, [sp]
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_offset_positive)
CNAME(ldpsw_sp_offset_positive):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #16
mov x9, sp
ldpsw x2, x3, [sp, #8]
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_offset_negative)
CNAME(ldpsw_sp_offset_negative):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #32
mov x9, sp
ldpsw x2, x3, [sp, #-8]
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_pre_positive)
CNAME(ldpsw_sp_pre_positive):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #16
mov x9, sp
ldpsw x2, x3, [sp, #16]!
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_pre_negative)
CNAME(ldpsw_sp_pre_negative):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #32
mov x9, sp
ldpsw x2, x3, [sp, #-16]!
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_post_positive)
CNAME(ldpsw_sp_post_positive):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #16
mov x9, sp
ldpsw x2, x3, [sp], #16
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
.p2align 2
.globl CNAME(ldpsw_sp_post_negative)
CNAME(ldpsw_sp_post_negative):
stp x29, x30, [sp, #-64]!
mov x8, sp
ldp x2, x3, [x1]
stp x2, x3, [sp, #16]
ldp x2, x3, [x1, #16]
stp x2, x3, [sp, #32]
add sp, sp, #32
mov x9, sp
ldpsw x2, x3, [sp], #-16
stp x2, x3, [x0]
mov x4, sp
sub x4, x4, x9
str x4, [x0, #16]
mov sp, x8
ldp x29, x30, [sp], #64
ret
