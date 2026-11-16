#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures;
static void check(const char *name, int ok) {
    printf("%s %s\n", ok ? "PASS" : "FAIL", name);
    if (!ok)
        failures++;
}
static int wait_ok(pid_t pid) {
    int status;
    return waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
static int signal_fd;
static void parent_signal(int sig, siginfo_t *info, void *unused) {
    (void)unused;
    pid_t sender = info->si_pid;
    if (sig == SIGUSR1)
        write(signal_fd, &sender, sizeof(sender));
    _exit(0);
}
static void child_wait(int ready_fd, int result_fd) {
    signal_fd = result_fd;
    struct sigaction action = {.sa_sigaction = parent_signal, .sa_flags = SA_SIGINFO};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) || prctl(PR_SET_PDEATHSIG, SIGUSR1))
        _exit(81);
    if (write(ready_fd, "r", 1) != 1)
        _exit(82);
    for (;;)
        pause();
}
static int read_sender(int fd, pid_t expected) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    pid_t sender = -1;
    return poll(&p, 1, 3000) == 1 && read(fd, &sender, sizeof(sender)) == sizeof(sender) &&
           sender == expected;
}
struct worker_params {
    int result_fd;
    pid_t child;
};
static void *parent_thread(void *arg) {
    struct worker_params *params = arg;
    int ready[2];
    if (pipe(ready))
        return (void *)1;
    params->child = fork();
    if (params->child == 0)
        child_wait(ready[1], params->result_fd);
    char byte;
    int ok = params->child > 0 && read(ready[0], &byte, 1) == 1;
    close(ready[0]);
    close(ready[1]);
    return ok ? NULL : (void *)1;
}
int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "exec-check")) {
        int sig = -1;
        return prctl(PR_GET_PDEATHSIG, &sig) || sig != SIGUSR1;
    }
    setbuf(stdout, NULL);
    alarm(20);
    int sig = -1;
    check("initial value", !prctl(PR_GET_PDEATHSIG, &sig) && sig == 0);
    check("set/get",
          !prctl(PR_SET_PDEATHSIG, SIGUSR1) && !prctl(PR_GET_PDEATHSIG, &sig) && sig == SIGUSR1);
    errno = 0;
    check("invalid negative signal", prctl(PR_SET_PDEATHSIG, -1L) == -1 && errno == EINVAL);
    errno = 0;
    check("invalid too large signal", prctl(PR_SET_PDEATHSIG, 65L) == -1 && errno == EINVAL);
    errno = 0;
    check("GET invalid address", prctl(PR_GET_PDEATHSIG, (void *)-1) == -1 && errno == EFAULT);
    pid_t child = fork();
    if (!child) {
        sig = -1;
        _exit(prctl(PR_GET_PDEATHSIG, &sig) || sig != 0);
    }
    check("fork clears child setting", child > 0 && wait_ok(child));
    check("parent setting remains", !prctl(PR_GET_PDEATHSIG, &sig) && sig == SIGUSR1);
    child = fork();
    if (!child) {
        if (prctl(PR_SET_PDEATHSIG, SIGUSR1))
            _exit(1);
        execl(argv[0], argv[0], "exec-check", NULL);
        _exit(2);
    }
    check("ordinary exec preserves setting", child > 0 && wait_ok(child));
    check("clear", !prctl(PR_SET_PDEATHSIG, 0L) && !prctl(PR_GET_PDEATHSIG, &sig) && sig == 0);
    for (int group = 0; group < 2; group++) {
        child = fork();
        if (!child) {
            if (prctl(PR_SET_PDEATHSIG, SIGUSR1))
                _exit(1);
            int result = group ? setresgid(-1, 1234, -1) : setresuid(-1, 1234, -1);
            _exit(result || prctl(PR_GET_PDEATHSIG, &sig) || sig != 0);
        }
        check(group ? "effective GID clears setting" : "effective UID clears setting",
              child > 0 && wait_ok(child));
    }
    int result[2];
    pipe(result);
    pid_t parent = fork();
    if (!parent) {
        int ready[2];
        pipe(ready);
        child = fork();
        if (!child)
            child_wait(ready[1], result[1]);
        char byte;
        _exit(child <= 0 || read(ready[0], &byte, 1) != 1);
    }
    check("parent exit sends signal with sender PID", parent > 0 && read_sender(result[0], parent));
    check("parent exits normally", parent > 0 && wait_ok(parent));
    close(result[0]);
    close(result[1]);
    pipe(result);
    struct worker_params params = {.result_fd = result[1], .child = -1};
    pthread_t thread;
    void *thread_result = (void *)1;
    int created = pthread_create(&thread, NULL, parent_thread, &params) == 0;
    if (created)
        pthread_join(thread, &thread_result);
    check("creating thread exit signals child while process stays alive",
          created && thread_result == NULL && read_sender(result[0], getpid()));
    if (params.child > 0)
        wait_ok(params.child);
    close(result[0]);
    close(result[1]);
    printf("SUMMARY failures=%d\n", failures);
    return failures != 0;
}
