#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

typedef void (*probe)(int64_t *, const int32_t *);
extern void ldpsw_offset_zero(int64_t *, const int32_t *);
extern void ldpsw_offset_positive(int64_t *, const int32_t *);
extern void ldpsw_offset_negative(int64_t *, const int32_t *);
extern void ldpsw_pre_positive(int64_t *, const int32_t *);
extern void ldpsw_pre_negative(int64_t *, const int32_t *);
extern void ldpsw_post_positive(int64_t *, const int32_t *);
extern void ldpsw_post_negative(int64_t *, const int32_t *);
extern void ldpsw_offset_nonnegative(int64_t *, const int32_t *);
extern void ldpsw_zero_first(int64_t *, const int32_t *);
extern void ldpsw_zero_second(int64_t *, const int32_t *);
extern void ldpsw_base_alias_first(int64_t *, const int32_t *);
extern void ldpsw_base_alias_second(int64_t *, const int32_t *);
extern void ldpsw_sp_offset(int64_t *, const int32_t *);
extern void ldpsw_sp_offset_positive(int64_t *, const int32_t *);
extern void ldpsw_sp_offset_negative(int64_t *, const int32_t *);
extern void ldpsw_sp_pre_positive(int64_t *, const int32_t *);
extern void ldpsw_sp_pre_negative(int64_t *, const int32_t *);
extern void ldpsw_sp_post_positive(int64_t *, const int32_t *);
extern void ldpsw_sp_post_negative(int64_t *, const int32_t *);

struct check {
    const char *name;
    probe run;
    int64_t expected[3];
};

static const struct check checks[] = {
    {"offset_zero", ldpsw_offset_zero, {-1LL, -2147483648LL, 0LL}},
    {"offset_positive", ldpsw_offset_positive, {7LL, -12345LL, 0LL}},
    {"offset_negative", ldpsw_offset_negative, {-1LL, -2147483648LL, 8LL}},
    {"pre_positive", ldpsw_pre_positive, {7LL, -12345LL, 8LL}},
    {"pre_negative", ldpsw_pre_negative, {-1LL, -2147483648LL, 0LL}},
    {"post_positive", ldpsw_post_positive, {-1LL, -2147483648LL, 8LL}},
    {"post_negative", ldpsw_post_negative, {7LL, -12345LL, 0LL}},
    {"offset_nonnegative", ldpsw_offset_nonnegative, {0LL, 2147483647LL, 16LL}},
    {"zero_first", ldpsw_zero_first, {12345LL, 2147483647LL, 16LL}},
    {"zero_second", ldpsw_zero_second, {-1LL, 12345LL, 0LL}},
    {"base_alias_first", ldpsw_base_alias_first, {-1LL, -2147483648LL, 0LL}},
    {"base_alias_second", ldpsw_base_alias_second, {-1LL, -2147483648LL, 0LL}},
    {"sp_offset", ldpsw_sp_offset, {-1LL, -2147483648LL, 0LL}},
    {"sp_offset_positive", ldpsw_sp_offset_positive, {7LL, -12345LL, 0LL}},
    {"sp_offset_negative", ldpsw_sp_offset_negative, {7LL, -12345LL, 0LL}},
    {"sp_pre_positive", ldpsw_sp_pre_positive, {0LL, 2147483647LL, 16LL}},
    {"sp_pre_negative", ldpsw_sp_pre_negative, {-1LL, -2147483648LL, -16LL}},
    {"sp_post_positive", ldpsw_sp_post_positive, {-1LL, -2147483648LL, 16LL}},
    {"sp_post_negative", ldpsw_sp_post_negative, {0LL, 2147483647LL, -16LL}},
};

static int run_check(const struct check *check, const int32_t *input) {
    int64_t out[3] = {0};
    check->run(out, input);
    int passed = out[0] == check->expected[0] &&
                 out[1] == check->expected[1] && out[2] == check->expected[2];
    printf("%s %s actual=%lld,%lld,%lld expected=%lld,%lld,%lld\n",
           passed ? "PASS" : "FAIL", check->name,
           (long long)out[0], (long long)out[1], (long long)out[2],
           (long long)check->expected[0], (long long)check->expected[1],
           (long long)check->expected[2]);
    return !passed;
}

static int check_cross_page(void) {
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0)
        return 1;
    char *pages = mmap(NULL, (size_t)page_size * 2, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (pages == MAP_FAILED)
        return 1;
    int32_t *input = (int32_t *)(pages + page_size - sizeof(int32_t));
    input[0] = INT32_MIN;
    input[1] = -1;
    const struct check check = {
        "offset_cross_page", ldpsw_offset_zero, {INT32_MIN, -1, 0},
    };
    int failure = run_check(&check, input);
    munmap(pages, (size_t)page_size * 2);
    return failure;
}

static int check_ldp32(const int32_t *input) {
    const int32_t *base = input;
    uint64_t first, second;
    __asm__ volatile("ldp %w0, %w1, [%2, #8]!"
                     : "=&r"(first), "=&r"(second), "+r"(base) : : "memory");
    int passed = first == 7 && second == UINT32_C(0xffffcfc7) && base == input + 2;
    printf("%s ldp32_pre_zero_extension\n", passed ? "PASS" : "FAIL");
    int failures = !passed;
    __asm__ volatile("ldp %w0, %w1, [%2], #-8"
                     : "=&r"(first), "=&r"(second), "+r"(base) : : "memory");
    passed = first == 7 && second == UINT32_C(0xffffcfc7) && base == input;
    printf("%s ldp32_post_zero_extension\n", passed ? "PASS" : "FAIL");
    return failures + !passed;
}

int main(void) {
    const int32_t input[] = {-1, INT32_MIN, 7, -12345, 0, INT32_MAX, 1, -9};
    int failures = 0;
    for (unsigned i = 0; i < sizeof(checks) / sizeof(checks[0]); i++)
        failures += run_check(&checks[i], input);
    const int32_t negative[] = {0, 0, 0, 0, -1, INT32_MIN};
    const struct check zero_negative = {
        "zero_first_negative", ldpsw_zero_first, {12345, INT32_MIN, 16},
    };
    failures += run_check(&zero_negative, negative);
    failures += check_cross_page();
    failures += check_ldp32(input);
    return failures != 0;
}
