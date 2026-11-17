#include "fs/fd.h"
#include "fs/poll.h"
#include "fs/sock.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/event.h>
#include <unistd.h>

static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static bool waiting, mutated, observe_wait;
static struct task *waiting_task;
static struct poll *waiting_set;
static atomic_int checks;

static void check(bool condition, const char *name) {
    checks++;
    if (!condition) { fprintf(stderr, "FAIL %s\n", name); _exit(1); }
    printf("PASS %s\n", name);
}

// Stop at the host wait boundary, after iSH has released the poll-set lock.
// A second real thread changes epoll membership before the wait returns.
int kevent(int queue, const struct kevent *changes, int count,
           struct kevent *events, int capacity, const struct timespec *timeout) {
    static int (*host_kevent)(int, const struct kevent *, int,
                              struct kevent *, int, const struct timespec *);
    if (!host_kevent) host_kevent = dlsym(RTLD_NEXT, "kevent");
    if (capacity > 0 && count == 0 && observe_wait && current == waiting_task) {
        check(!list_empty(&current->sockrestart.listen),
              "host wait owns a live recovery registration independent of fd count");
        pthread_mutex_lock(&gate);
        waiting = true;
        pthread_cond_broadcast(&changed);
        while (!mutated) pthread_cond_wait(&changed, &gate);
        pthread_mutex_unlock(&gate);
    }
    return host_kevent(queue, changes, count, events, capacity, timeout);
}

static int event(void *context, int types, union poll_fd_info info) {
    (void)context; (void)types; (void)info;
    return 1;
}

static void *wait_main(void *opaque) {
    current = opaque;
    current->thread = pthread_self();
    struct timespec timeout = {.tv_nsec = 1000000};
    int result = poll_wait(waiting_set, event, NULL, &timeout);
    check(result >= 0, "poll wait completes after concurrent membership change");
    check(list_empty(&current->sockrestart.listen),
          "completed wait removes its task from listener recovery before task release");
    return NULL;
}

static void add_socket(struct poll *set, int number) {
    check(poll_add_fd(set, f_get(number), number, POLL_READ,
                      (union poll_fd_info){.fd = number}) == 0,
          "socket added to real poll set");
}

static void membership_change(int remove_count, int add_count, bool close_watched) {
    struct task *init = current;
    struct task waiter = *init;
    waiter.sockrestart = (struct task_sockrestart){};
    list_init(&waiter.sockrestart.listen);
    waiting_task = &waiter;
    waiting_set = poll_create();
    check(!IS_ERR(waiting_set), "poll set created");
    int first = sys_socket(AF_INET_, SOCK_STREAM_, 0);
    int second = remove_count > 1 ? sys_dup(first) : sys_socket(AF_INET_, SOCK_STREAM_, 0);
    check(first >= 0 && second >= 0, "guest sockets created");
    if (remove_count) add_socket(waiting_set, first);
    if (remove_count > 1) add_socket(waiting_set, second);
    waiting = mutated = false;
    observe_wait = true;
    pthread_t thread;
    check(pthread_create(&thread, NULL, wait_main, &waiter) == 0, "polling thread started");
    pthread_mutex_lock(&gate);
    while (!waiting) pthread_cond_wait(&changed, &gate);
    pthread_mutex_unlock(&gate);
    if (close_watched)
        check(f_close(first) == 0, "closing the watched socket removes it during wait");
    else if (remove_count)
        check(poll_del_fd(waiting_set, f_get(first), first) == 0,
              "socket removed while another thread is waiting");
    if (add_count) add_socket(waiting_set, second);
    pthread_mutex_lock(&gate);
    mutated = true;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&gate);
    pthread_join(thread, NULL);
    observe_wait = false;
    // A second wait catches an unbalanced unregister when a socket was added
    // to an initially empty set. Reuse the task just as Tokio reuses a worker.
    current = &waiter;
    current->thread = pthread_self();
    struct timespec timeout = {};
    check(poll_wait(waiting_set, event, NULL, &timeout) >= 0 &&
          list_empty(&waiter.sockrestart.listen),
          "worker can wait again without stale listener registration");
    current = init;
    poll_destroy(waiting_set);
    if (!close_watched) f_close(first);
    f_close(second);
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL); alarm(10);
    if (argc != 2 || mount_root(&fakefs, argv[1]) || become_first_process()) return 2;
    ish_set_listener_recovery(true);
    struct task *init = current;
    membership_change(1, 0, false);
    current = init;
    membership_change(0, 1, false);
    current = init;
    membership_change(1, 1, false);
    current = init;
    membership_change(2, 0, false);
    current = init;
    membership_change(1, 0, true);
    printf("PASS poll waiter lifetime: %d assertions\n", checks);
    return 0;
}
