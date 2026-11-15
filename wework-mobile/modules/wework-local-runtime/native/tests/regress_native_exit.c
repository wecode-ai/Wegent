#include "fs/fd.h"
#include "fs/real.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/mm.h"
#include "kernel/task.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern int do_wait(int, pid_t_, struct siginfo_ *, struct rusage_ *, int);
extern int wework_ish_memory_start(void);
static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static int worker_ready, worker_release;
static void leave(void *unused) {
    (void)unused;
    ish_host_task_leave();
}
static void *worker_main(void *opaque) {
    current = opaque;
    current->thread = pthread_self();
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGUSR1);
    pthread_sigmask(SIG_BLOCK, &mask, NULL);
    pthread_cleanup_push(leave, NULL);
    pthread_mutex_lock(&gate);
    worker_ready = 1;
    pthread_cond_broadcast(&changed);
    while (!worker_release)
        pthread_cond_wait(&changed, &gate);
    pthread_mutex_unlock(&gate);
    do_exit(7 << 8);
    pthread_cleanup_pop(1);
    return NULL;
}
static void *leader_main(void *opaque) {
    current = opaque;
    current->thread = pthread_self();
    pthread_cleanup_push(leave, NULL);
    do_exit_group(7 << 8);
    pthread_cleanup_pop(1);
    return NULL;
}

static int discard_probe(struct task *init) {
    int pipe_fds[2];
    if (pipe(pipe_fds) != 0 || become_new_init_child() != 0)
        return 2;
    struct task *child = current;
    int pid = child->pid;
    struct fd *input = adhoc_fd_create(&realfs_fdops);
    if (input == NULL)
        return 2;
    input->real_fd = pipe_fds[0];
    child->files->files[0] = input;
    if (do_execve("/bin/true", 1, "/bin/true\0", "PATH=/bin\0") != 0)
        return 2;
    current = init;
    ish_host_task_enter();
    ish_host_task_leave();
    task_discard_unstarted(child);
    lock(&pids_lock);
    int absent = pid_get_task_zombie(pid) == NULL && list_empty(&init->children);
    unlock(&pids_lock);
    errno = 0;
    int closed = fcntl(pipe_fds[0], F_GETFD) == -1 && errno == EBADF;
    close(pipe_fds[1]);
    int cleaned = absent && closed && current == init && ish_host_task_count() == 0;
    printf("%s discard unstarted exec closes descriptors and removes task without changing owner\n",
           cleaned ? "PASS" : "FAIL");
    if (become_new_init_child() != 0)
        return 2;
    child = current;
    task_discard_unstarted(child);
    int recovered = current == NULL && list_empty(&init->children) && ish_host_task_count() == 0;
    current = init;
    printf("%s next child can be constructed and discarded after failed native creation\n",
           recovered ? "PASS" : "FAIL");
    return !cleaned || !recovered;
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL);
    alarm(15);
    if (argc != 2 || wework_ish_memory_start() || mount_root(&fakefs, argv[1]) ||
        become_first_process())
        return 2;
    struct task *init = current;
    init->thread = pthread_self();
    if (discard_probe(init) != 0)
        return 1;
    if (become_new_init_child())
        return 2;
    struct task *leader = current;
    int pid = leader->pid;
    struct task *worker = task_create_(leader);
    if (worker == NULL)
        return 2;
    mm_retain(worker->mm);
    worker->files->refcount++;
    worker->fs->refcount++;
    worker->sighand->refcount++;
    lock(&pids_lock);
    list_add(&leader->group->threads, &worker->group_links);
    unlock(&pids_lock);
    current = init;
    pthread_t worker_thread, leader_thread;
    ish_host_task_enter();
    if (pthread_create(&worker_thread, NULL, worker_main, worker))
        return 2;
    pthread_mutex_lock(&gate);
    while (!worker_ready)
        pthread_cond_wait(&changed, &gate);
    pthread_mutex_unlock(&gate);
    ish_host_task_enter();
    if (pthread_create(&leader_thread, NULL, leader_main, leader))
        return 2;
    pthread_join(leader_thread, NULL);
    usleep(1200000);
    struct siginfo_ info = {};
    int result = do_wait(1, pid, &info, NULL, 4 | 1 | (1 << 24));
    lock(&pids_lock);
    struct task *retained = pid_get_task_zombie(pid);
    int retained_ok = retained != NULL && !retained->zombie && retained->exiting &&
                      list_size(&retained->group->threads) == 1;
    unlock(&pids_lock);
    int visible = result == 0 && info.child.pid == 0 && retained_ok && ish_host_task_count() == 1;
    printf("%s live native worker prevents wait/reap beyond old timeout\n",
           visible ? "PASS" : "FAIL");
    pthread_mutex_lock(&gate);
    worker_release = 1;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&gate);
    pthread_join(worker_thread, NULL);
    result = do_wait(1, pid, &info, NULL, 4);
    int drained = result == 0 && info.child.pid == pid && info.child.status == (7 << 8) &&
                  ish_host_task_count() == 0;
    printf("%s all native threads exit before final reap; count=0\n", drained ? "PASS" : "FAIL");
    return !visible || !drained;
}
