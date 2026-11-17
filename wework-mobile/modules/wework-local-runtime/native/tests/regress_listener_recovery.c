#include "fs/fd.h"
#include "fs/poll.h"
#include "fs/real.h"
#include "fs/sock.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int target = -1, stale, fail_bind, bind_attempts, checks, guest_shutdown;

// Device evidence: POLLIN alone reports no event on a reclaimed listener,
// while the full mask reports HUP and accept still returns EAGAIN.
int poll(struct pollfd *fds, nfds_t count, int timeout) {
    static int (*host_poll)(struct pollfd *, nfds_t, int);
    if (!host_poll) host_poll = dlsym(RTLD_NEXT, "poll");
    int result = host_poll(fds, count, timeout);
    if (stale && timeout == 0 && count == 1 && fds[0].fd == target) {
        fds[0].revents = fds[0].events & (POLLOUT | POLLPRI) ? POLLHUP : 0;
        return fds[0].revents != 0;
    }
    return result;
}

int accept(int fd, struct sockaddr *address, socklen_t *length) {
    static int (*host_accept)(int, struct sockaddr *, socklen_t *);
    if (!host_accept) host_accept = dlsym(RTLD_NEXT, "accept");
    if (stale && fd == target) { errno = EAGAIN; return -1; }
    return host_accept(fd, address, length);
}

int listen(int fd, int backlog) {
    static int (*host_listen)(int, int);
    if (!host_listen) host_listen = dlsym(RTLD_NEXT, "listen");
    int result = host_listen(fd, backlog);
    if (result == 0 && fd == target) stale = 0;
    return result;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
    static int (*host_bind)(int, const struct sockaddr *, socklen_t);
    if (!host_bind) host_bind = dlsym(RTLD_NEXT, "bind");
    if (fd == target && fail_bind) { bind_attempts++; errno = EADDRINUSE; return -1; }
    return host_bind(fd, address, length);
}

int shutdown(int fd, int how) {
    static int (*host_shutdown)(int, int);
    if (!host_shutdown) host_shutdown = dlsym(RTLD_NEXT, "shutdown");
    // Exercise a successful guest shutdown independently of Darwin's
    // ENOTCONN rejection for shutdown on a listening socket.
    if (guest_shutdown && fd == target) { stale = 1; return 0; }
    return host_shutdown(fd, how);
}

static void check(int condition, const char *name) {
    checks++;
    if (!condition) { fprintf(stderr, "FAIL %s\n", name); _exit(1); }
    printf("PASS %s\n", name);
}

static int event(void *context, int types, union poll_fd_info info) {
    (void)info;
    *(int *)context |= types;
    return 1;
}

static int wait_events(struct poll *set, int *types, int seconds) {
    *types = 0;
    struct timespec timeout = {.tv_sec = seconds};
    return poll_wait(set, event, types, &timeout);
}

static int create_listener(int family, struct sockaddr_storage *address, socklen_t *length) {
    int guest = sys_socket(family == AF_INET ? AF_INET_ : AF_INET6_, SOCK_STREAM_, 0);
    check(guest >= 0, "guest TCP socket created");
    struct fd *fd = f_get(guest);
    int one = 1;
    check(sockrestart_setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) == 0,
          "socket options set before listen are retained");
    check(fd_setflags(fd, O_NONBLOCK_) == 0, "listener is nonblocking");
    memset(address, 0, sizeof(*address));
    if (family == AF_INET) {
        struct sockaddr_in *v4 = (struct sockaddr_in *)address;
        v4->sin_family = AF_INET; v4->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        *length = sizeof(*v4);
    } else {
        struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)address;
        v6->sin6_family = AF_INET6; v6->sin6_addr = in6addr_loopback;
        *length = sizeof(*v6);
    }
    check(bind(fd->real_fd, (struct sockaddr *)address, *length) == 0, "listener bound");
    check(sys_listen(guest, 7) == 0 && sys_listen(guest, 11) == 0,
          "repeated listen updates backlog without corrupting registration");
    check(getsockname(fd->real_fd, (struct sockaddr *)address, length) == 0,
          "actual ephemeral port captured");
    return guest;
}

static int client_connect(struct sockaddr_storage *address, socklen_t length) {
    int client = socket(address->ss_family, SOCK_STREAM, 0);
    check(client >= 0 && connect(client, (struct sockaddr *)address, length) == 0,
          "client connects to the original address");
    return client;
}

static void reclaim_endpoint(int family) {
    int replacement = socket(family, SOCK_STREAM, 0);
    int flags = fcntl(target, F_GETFL), descriptor_flags = fcntl(target, F_GETFD);
    check(replacement >= 0 && fcntl(replacement, F_SETFL, flags) == 0 &&
          dup2(replacement, target) == target && fcntl(target, F_SETFD, descriptor_flags) == 0,
          "host listening endpoint reclaimed without changing descriptor flags");
    close(replacement);
    stale = 1;
}

static void recover_family(int family) {
    struct sockaddr_storage address, restored;
    socklen_t length;
    int guest = create_listener(family, &address, &length);
    struct fd *fd = f_get(guest);
    check(realfs_poll(fd) == 0, "healthy idle listener has no closed readiness");
    struct poll *first = poll_create(), *second = poll_create(), *oneshot = poll_create();
    check(!IS_ERR(first) && !IS_ERR(second) && !IS_ERR(oneshot), "independent poll sets created");
    check(poll_add_fd(first, fd, guest, POLL_READ | POLL_EDGETRIGGERED,
                      (union poll_fd_info){.fd = guest}) == 0 &&
          poll_add_fd(second, fd, guest, POLL_READ | POLL_EDGETRIGGERED,
                      (union poll_fd_info){.fd = guest}) == 0,
          "both poll sets watch the same open-file description");
    int duplicate = sys_dup(guest);
    check(duplicate >= 0 && f_get(duplicate) == fd &&
          poll_add_fd(first, fd, duplicate, POLL_READ | POLL_EDGETRIGGERED,
                      (union poll_fd_info){.fd = duplicate}) == 0,
          "duplicated descriptors retain independent epoll registrations");
    check(poll_add_fd(oneshot, fd, guest, POLL_READ | POLL_ONESHOT,
                      (union poll_fd_info){.fd = guest}) == 0,
          "oneshot registration created");
    int initial = client_connect(&address, length), initial_types;
    check(wait_events(oneshot, &initial_types, 1) == 1, "oneshot fired before reclamation");
    int initial_accepted = sys_accept(guest, 0, 0);
    check(initial_accepted >= 0, "initial connection accepted");
    close(initial); f_close(initial_accepted);
    check(fcntl(fd->real_fd, F_SETFD, FD_CLOEXEC) == 0, "host descriptor flags set");
    int buffer = 32768;
    check(sockrestart_setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buffer, sizeof(buffer)) == 0,
          "socket options updated after listen are retained");
    int original_buffer = 0; socklen_t option_size = sizeof(original_buffer);
    check(getsockopt(fd->real_fd, SOL_SOCKET, SO_RCVBUF, &original_buffer, &option_size) == 0,
          "original buffer option measured");
    int original_reuse = 0; option_size = sizeof(original_reuse);
    check(getsockopt(fd->real_fd, SOL_SOCKET, SO_REUSEADDR, &original_reuse, &option_size) == 0 &&
          original_reuse != 0, "original native reuse option measured");
    for (int cycle = 0; cycle < 2; cycle++) {
        target = fd->real_fd;
        reclaim_endpoint(family);
        if (cycle == 1)
            check(sys_accept(guest, 0, 0) == _EAGAIN,
                  "accept detects reclamation before waiting for a new client");
        int types;
        check(wait_events(first, &types, 0) == 0 && !(types & POLL_HUP),
              "host-only HUP never becomes permanent guest closed readiness");
        check(atomic_load(&fd->real_generation) == (unsigned)cycle + 1,
              "one descriptor generation per successful restoration");
        check(wait_events(second, &types, 0) == 0, "second poll backend refreshed");
        check(wait_events(oneshot, &types, 0) == 0, "restoration does not re-arm fired ONESHOT");
        check(poll_mod_fd(oneshot, fd, guest, POLL_READ | POLL_ONESHOT,
                         (union poll_fd_info){.fd = guest}) == 0, "guest explicitly re-arms ONESHOT");
        socklen_t restored_length = sizeof(restored);
        check(getsockname(target, (struct sockaddr *)&restored, &restored_length) == 0 &&
              restored_length == length && memcmp(&restored, &address, length) == 0,
              "bind address and port preserved");
        int value = 0; option_size = sizeof(value);
        int restored_flags = fcntl(target, F_GETFL);
        int option_result = getsockopt(target, SOL_SOCKET, SO_REUSEADDR, &value, &option_size);
        if (!(restored_flags & O_NONBLOCK) || option_result != 0 || value != original_reuse)
            fprintf(stderr, "restored flags=%d reuse=%d result=%d errno=%d\n",
                    restored_flags, value, option_result, errno);
        check((restored_flags & O_NONBLOCK) != 0 && option_result == 0 && value == original_reuse &&
              (fcntl(target, F_GETFD) & FD_CLOEXEC) != 0,
              "nonblocking mode and pre-listen options preserved");
        option_size = sizeof(value);
        check(getsockopt(target, SOL_SOCKET, SO_RCVBUF, &value, &option_size) == 0 &&
              value == original_buffer, "post-listen options preserved");
        int client = client_connect(&address, length);
        check(wait_events(first, &types, 1) == 2 && (types & POLL_READ) && !(types & POLL_HUP),
              "first reactor receives new connections after restoration");
        check(wait_events(second, &types, 1) == 1 && (types & POLL_READ),
              "second reactor receives new connections after restoration");
        check(wait_events(oneshot, &types, 1) == 1 && (types & POLL_READ),
              "re-armed ONESHOT receives the new connection");
        int accepted = sys_accept(guest, 0, 0);
        check(accepted >= 0, "guest accepts the new connection");
        close(client); f_close(accepted);
    }
    unsigned generation = atomic_load(&fd->real_generation);
    guest_shutdown = 1;
    check(sys_shutdown(guest, SHUT_RD) == 0 && sockrestart_check_listener(fd) == 0 &&
          atomic_load(&fd->real_generation) == generation,
          "explicit guest shutdown is never restored");
    guest_shutdown = 0; stale = 0;
    poll_destroy(first); poll_destroy(second); poll_destroy(oneshot);
    f_close(duplicate); f_close(guest); target = -1;
}

static void failed_restore(void) {
    struct sockaddr_storage address; socklen_t length;
    int guest = create_listener(AF_INET, &address, &length);
    struct fd *fd = f_get(guest);
    target = fd->real_fd;
    reclaim_endpoint(AF_INET);
    fail_bind = 1; bind_attempts = 0;
    check(sockrestart_check_listener(fd) == -EADDRINUSE && bind_attempts == 1,
          "restoration failure retains the original host error");
    check(sockrestart_check_listener(fd) == -EADDRINUSE && bind_attempts == 1 &&
          sys_accept(guest, 0, 0) == _EADDRINUSE,
          "failed restoration is observable without an unbounded retry");
    fail_bind = 0; stale = 0; f_close(guest); target = -1;
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL); alarm(15);
    if (argc != 2 || mount_root(&fakefs, argv[1]) || become_first_process()) return 2;
    ish_set_listener_recovery(true);
    recover_family(AF_INET);
    recover_family(AF_INET6);
    failed_restore();
    struct ish_listener_diagnostics diagnostics = ish_get_listener_diagnostics();
    check(diagnostics.restored == 4, "diagnostics count each successful restoration once");
    check(diagnostics.failures == 1 && diagnostics.host_error == EADDRINUSE,
          "diagnostics retain a failed restoration without counting repeated reads");
    printf("PASS listener recovery: %d assertions\n", checks);
    return 0;
}
