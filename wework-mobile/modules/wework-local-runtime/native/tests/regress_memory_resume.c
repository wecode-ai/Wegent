#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "kernel/calls.h"
#include "kernel/mm.h"

static const uint64_t allowance = 1024ULL << 20;
static struct ish_memory_status next_status;
static int read_error;
static atomic_int reads;
static int assertions;

#define CHECK(condition) do { \
    if (!(condition)) { fprintf(stderr, "FAIL %s\n", #condition); exit(1); } \
    assertions++; \
} while (0)

static int read_status(struct ish_memory_status *status) {
    atomic_fetch_add(&reads, 1);
    *status = next_status;
    return read_error;
}

static void stale_sample(void) {
    ish_set_memory_status(allowance, allowance, false);
    struct timespec remaining = {.tv_sec = 2, .tv_nsec = 100000000};
    while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {}
}

static void refresh_after_suspension(void) {
    stale_sample();
    CHECK(!ish_mem_commit_ok(4096));
    next_status = (struct ish_memory_status) {allowance, allowance, false};
    ish_set_memory_refresh_handler(read_status);
    CHECK(ish_mem_commit_ok(4096));
    CHECK(atomic_load(&reads) == 1);
    CHECK(ish_mem_commit_ok(4096));
    CHECK(atomic_load(&reads) == 1);
    CHECK(!ish_mem_commit_ok(allowance + 1));
}

static void preserve_pressure_policy(void) {
    ish_set_memory_status(allowance, allowance / 20, false);
    CHECK(!ish_mem_commit_ok(4096));
    ish_set_memory_status(allowance, allowance * 14 / 100, false);
    CHECK(!ish_mem_commit_ok(4096));
    ish_set_memory_status(allowance, allowance / 5, false);
    CHECK(ish_mem_commit_ok(4096));
    stale_sample();
    next_status.pressure_critical = true;
    int before = sys_syslog(9, 0, 0);
    CHECK(!ish_mem_commit_ok(4096));
    CHECK(sys_syslog(9, 0, 0) == before);
}

static void fail_closed_on_invalid_host_reads(void) {
    stale_sample();
    read_error = -EIO;
    CHECK(!ish_mem_commit_ok(4096));
    read_error = 0;
    next_status = (struct ish_memory_status) {0, 0, false};
    CHECK(!ish_mem_commit_ok(4096));
    next_status = (struct ish_memory_status) {allowance, allowance + 1, false};
    CHECK(!ish_mem_commit_ok(4096));
    next_status = (struct ish_memory_status) {allowance, allowance, false};
    CHECK(ish_mem_commit_ok(4096));
}

static void *admit_concurrently(void *unused) {
    (void)unused;
    for (int i = 0; i < 64; i++)
        if (!ish_mem_commit_ok(4096)) return (void *)1;
    return NULL;
}

static void concurrent_resume(void) {
    stale_sample();
    pthread_t threads[8];
    for (int i = 0; i < 8; i++) CHECK(pthread_create(&threads[i], NULL, admit_concurrently, NULL) == 0);
    for (int i = 0; i < 8; i++) {
        void *result;
        CHECK(pthread_join(threads[i], &result) == 0);
        CHECK(result == NULL);
    }
}

int main(void) {
    refresh_after_suspension();
    preserve_pressure_policy();
    fail_closed_on_invalid_host_reads();
    concurrent_resume();
    printf("PASS memory resume: %d assertions; fresh host reads, pressure hysteresis, "
           "invalid reads, concurrent admission and no allocation-path logging\n", assertions);
    return 0;
}
