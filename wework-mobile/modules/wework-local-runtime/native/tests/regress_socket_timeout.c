#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* Exercise the actual Linux ARM64 wire ABI, independently of libc aliases. */
struct timeout_value { int64_t sec, usec; };
static int failures;

static void check(int passed, const char *name, int option) {
    printf("%s timeout_%d_%s errno=%d\n", passed ? "PASS" : "FAIL", option, name, errno);
    failures += !passed;
}

static int set_timeout(int fd, int option, const void *value, socklen_t len) {
    return syscall(SYS_setsockopt, fd, SOL_SOCKET, option, value, len);
}

static int get_timeout(int fd, int option, void *value, socklen_t *len) {
    return syscall(SYS_getsockopt, fd, SOL_SOCKET, option, value, len);
}

static int value_is(int fd, int option, struct timeout_value wanted) {
    struct timeout_value actual = {-1, -1};
    socklen_t len = sizeof(actual);
    return get_timeout(fd, option, &actual, &len) == 0 &&
        len == sizeof(actual) && actual.sec == wanted.sec && actual.usec == wanted.usec;
}

static int64_t monotonic_us(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}

static void check_abi(int fd, int option) {
    struct timeout_value value = {1, 654321};
    check(set_timeout(fd, option, &value, sizeof(value)) == 0 && value_is(fd, option, value),
          "roundtrip", option);
    int other = option < 64 ? option + 46 : option - 46;
    check(value_is(fd, other, value), "old_new_shared_option", option);
    int alias = dup(fd);
    check(alias >= 0 && value_is(alias, option, value), "dup_shared_option", option);
    close(alias);

    const struct timeout_value invalid[] = {
        {0, -1}, {0, 1000000}, {0, INT64_C(4294967296)}, {-1, 0}, {INT64_MAX, 0},
    };
    const char *names[] = {"negative_usec", "million_usec", "wide_usec", "negative_sec_limit", "overflow_limit"};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        errno = 0;
        int result = set_timeout(fd, option, &invalid[i], sizeof(value));
        check(result == -1 && errno == (i == 4 ? EOVERFLOW : EDOM), names[i], option);
    }
    check(value_is(fd, option, value), "invalid_preserves_value", option);
    errno = 0;
    check(set_timeout(fd, option, &value, sizeof(value) - 1) == -1 && errno == EINVAL,
          "short_input", option);
    errno = 0;
    check(set_timeout(fd, option, &value, UINT_MAX) == -1 && errno == EINVAL,
          "signed_input_length", option);
    errno = 0;
    check(set_timeout(fd, option, NULL, sizeof(value)) == -1 && errno == EFAULT,
          "null_input", option);

    const socklen_t sizes[] = {0, 1, 4, 8, 12, 15, 16, 24};
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        unsigned char actual[32], expected[32];
        memset(actual, 0xa5, sizeof(actual));
        memset(expected, 0xa5, sizeof(expected));
        socklen_t size = sizes[i], copied = size < sizeof(value) ? size : sizeof(value);
        memcpy(expected, &value, copied);
        char name[32];
        snprintf(name, sizeof(name), "get_prefix_%u", size);
        check(get_timeout(fd, option, actual, &size) == 0 && size == copied &&
              memcmp(actual, expected, sizeof(actual)) == 0, name, option);
    }
    socklen_t len = 0;
    check(get_timeout(fd, option, NULL, &len) == 0 && len == 0, "get_null_zero", option);
    len = 24;
    errno = 0;
    check(get_timeout(fd, option, NULL, &len) == -1 && errno == EFAULT && len == 24,
          "get_fault_preserves_length", option);
    len = UINT_MAX;
    errno = 0;
    check(get_timeout(fd, option, &value, &len) == -1 && errno == EINVAL && len == UINT_MAX,
          "get_signed_length", option);
    errno = 0;
    check(get_timeout(fd, option, &value, NULL) == -1 && errno == EFAULT,
          "get_null_length", option);

    long page = sysconf(_SC_PAGESIZE);
    char *pages = mmap(NULL, (size_t)page * 2, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (pages == MAP_FAILED || mprotect(pages + page, page, PROT_NONE)) {
        check(0, "protected_tail_setup", option);
        return;
    }
    void *tail = pages + page - sizeof(value);
    memcpy(tail, &value, sizeof(value));
    check(set_timeout(fd, option, tail, INT_MAX) == 0 && value_is(fd, option, value),
          "oversized_input_reads_struct_only", option);
    memset(tail, 0xa5, sizeof(value));
    len = INT_MAX;
    check(get_timeout(fd, option, tail, &len) == 0 && len == sizeof(value) &&
          memcmp(tail, &value, sizeof(value)) == 0, "oversized_output_writes_struct_only", option);
    munmap(pages, (size_t)page * 2);
    value = (struct timeout_value){0, 0};
    check(set_timeout(fd, option, &value, sizeof(value)) == 0 && value_is(fd, option, value),
          "zero_roundtrip", option);
}

struct delayed_io { int fd; int receive; int result; };

static void *delayed_io(void *opaque) {
    struct delayed_io *io = opaque;
    usleep(40000);
    char buffer[16384] = {'x'};
    io->result = io->receive ? recv(io->fd, buffer, sizeof(buffer), 0) : send(io->fd, buffer, 1, 0);
    return NULL;
}

static void check_receive_timeout(int option) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) {
        check(0, "socketpair", option);
        return;
    }
    struct timeout_value value = {0, 50000};
    check(set_timeout(pair[0], option, &value, sizeof(value)) == 0, "receive_setup", option);
    char byte;
    struct iovec iov = {&byte, 1};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
    for (int kind = 0; kind < 3; kind++) {
        int64_t start = monotonic_us();
        errno = 0;
        int result = kind == 0 ? recv(pair[0], &byte, 1, 0) :
                     kind == 1 ? recvmsg(pair[0], &message, 0) : read(pair[0], &byte, 1);
        int saved = errno;
        int64_t elapsed = monotonic_us() - start;
        const char *names[] = {"recv_bounded", "recvmsg_bounded", "read_bounded"};
        check(result == -1 && saved == EAGAIN && elapsed >= 10000 && elapsed < 1500000,
              names[kind], option);
    }
    value.usec = 1;
    check(set_timeout(pair[0], option, &value, sizeof(value)) == 0 && value_is(pair[0], option, value),
          "one_usec_roundtrip", option);
    int64_t start = monotonic_us();
    errno = 0;
    int result = recv(pair[0], &byte, 1, 0);
    check(result == -1 && errno == EAGAIN && monotonic_us() - start < 500000,
          "one_usec_is_finite", option);

    value = (struct timeout_value){0, 0};
    check(set_timeout(pair[0], option, &value, sizeof(value)) == 0, "reset_infinite", option);
    pthread_t thread;
    struct delayed_io io = {pair[1], 0, -1};
    int created = pthread_create(&thread, NULL, delayed_io, &io);
    start = monotonic_us();
    result = created ? -1 : recv(pair[0], &byte, 1, 0);
    if (!created)
        pthread_join(thread, NULL);
    check(!created && result == 1 && byte == 'x' && io.result == 1 &&
          monotonic_us() - start >= 20000, "zero_waits_for_delayed_data", option);
    check(send(pair[1], "y", 1, 0) == 1 && recv(pair[0], &byte, 1, 0) == 1 && byte == 'y',
          "ready_data_after_reset", option);
    close(pair[0]);
    close(pair[1]);
}

static int fill_socket(int fd) {
    char data[4096] = {0};
    for (int attempts = 0; attempts < 256; attempts++) {
        if (send(fd, data, sizeof(data), MSG_DONTWAIT) < 0)
            return errno == EAGAIN;
    }
    return 0;
}

static void check_send_timeout(int option) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) {
        check(0, "socketpair", option);
        return;
    }
    int size = 4096;
    struct timeout_value value = {0, 50000};
    check(setsockopt(pair[0], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size)) == 0 &&
          set_timeout(pair[0], option, &value, sizeof(value)) == 0 && fill_socket(pair[0]),
          "send_setup_full_buffer", option);
    char byte = 'z';
    struct iovec iov = {&byte, 1};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1};
    for (int kind = 0; kind < 3; kind++) {
        int64_t start = monotonic_us();
        errno = 0;
        int result = kind == 0 ? send(pair[0], &byte, 1, 0) :
                     kind == 1 ? sendmsg(pair[0], &message, 0) : write(pair[0], &byte, 1);
        int saved = errno;
        int64_t elapsed = monotonic_us() - start;
        const char *names[] = {"send_bounded", "sendmsg_bounded", "write_bounded"};
        check(result == -1 && saved == EAGAIN && elapsed >= 10000 && elapsed < 1500000,
              names[kind], option);
    }
    value = (struct timeout_value){0, 0};
    check(set_timeout(pair[0], option, &value, sizeof(value)) == 0, "send_reset_infinite", option);
    pthread_t thread;
    struct delayed_io io = {pair[1], 1, -1};
    int created = pthread_create(&thread, NULL, delayed_io, &io);
    int result = created ? -1 : send(pair[0], &byte, 1, 0);
    if (!created)
        pthread_join(thread, NULL);
    check(!created && result == 1 && io.result > 0, "zero_waits_for_delayed_drain", option);
    close(pair[0]);
    close(pair[1]);
}

int main(void) {
    /* Bound regressions that would accidentally turn finite waits into infinity. */
    alarm(10);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return 1;
    const int options[] = {20, 21, 66, 67};
    for (unsigned i = 0; i < sizeof(options) / sizeof(options[0]); i++)
        check_abi(fd, options[i]);
    int enabled = 1, actual = 0;
    socklen_t size = sizeof(actual);
    /* This unrelated option preserves Darwin's nonzero bitmask (4), not 1. */
    int enabled_ok = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) == 0 &&
        getsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &actual, &size) == 0 && actual != 0;
    printf("INFO SO_REUSEADDR enabled_value=%d\n", actual);
    enabled = 0;
    check(enabled_ok && setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) == 0 &&
          getsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &actual, &size) == 0 && actual == 0,
          "unrelated_integer_option", 2);
    close(fd);
    check_receive_timeout(20);
    check_receive_timeout(66);
    check_send_timeout(21);
    check_send_timeout(67);
    return failures != 0;
}
