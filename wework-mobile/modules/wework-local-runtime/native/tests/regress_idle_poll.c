#include "fs/fd.h"
#include "fs/poll.h"
#include "fs/real.h"
#include "kernel/task.h"
#include "kernel/init.h"
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void expired(int signal) {
    (void)signal;
    const char message[] = "FAIL idle poll killed the process or stranded its cleanup lock\n";
    write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(1);
}

static void check(bool condition, const char *name) {
    if (!condition) { fprintf(stderr, "FAIL %s\n", name); exit(1); }
    printf("PASS %s\n", name);
}

static int event(void *context, int types, union poll_fd_info info) {
    (void)context; (void)types; (void)info;
    return 1;
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL);
    signal(SIGALRM, expired);
    alarm(8);
    if (argc != 2 || mount_root(&fakefs, argv[1]) || become_first_process() ||
        become_new_init_child()) return 2;
    current->thread = pthread_self();
    int pipe_fds[2];
    check(pipe(pipe_fds) == 0, "idle service pipe created");
    struct fd *fd = adhoc_fd_create(&realfs_fdops);
    check(fd != NULL, "idle service descriptor created");
    fd->real_fd = pipe_fds[0];
    int number = f_install(fd, 0);
    check(number >= 0, "idle service owns descriptor until explicit close");
    struct poll *set = poll_create();
    check(!IS_ERR(set) && poll_add_fd(set, fd, number, POLL_READ,
          (union poll_fd_info){.fd = number}) == 0, "idle service registered with poll");

    // Suspension advances monotonic time without any guest progress. Exercise
    // that state directly so the regression does not need a minute-long sleep.
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    atomic_store(&current->group->last_progress_ns,
        ((uint64_t)now.tv_sec - 120) * 1000000000ULL + now.tv_nsec);
    struct timespec timeout = {.tv_sec = 1};
    check(poll_wait(set, event, NULL, &timeout) == 0,
          "idle service survives a normal poll timeout after suspension");
    check(!current->group->doing_group_exit && !current->exiting,
          "inactivity never changes guest process lifetime");
    check(write(pipe_fds[1], "x", 1) == 1, "service receives new work after idle");
    timeout = (struct timespec){};
    check(poll_wait(set, event, NULL, &timeout) == 1,
          "original poll registration delivers new work");
    poll_destroy(set);
    check(f_close(number) == 0, "explicit close releases poll locks normally");
    close(pipe_fds[1]);
    puts("PASS idle poll process lifetime: 9 assertions");
    return 0;
}
