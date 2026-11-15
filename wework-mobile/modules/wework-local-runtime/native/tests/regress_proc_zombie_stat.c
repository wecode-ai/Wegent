#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
static int hold[2];
static void *worker(void *unused) {
    (void)unused;
    char byte;
    read(hold[0], &byte, 1);
    return NULL;
}
static int read_stat(pid_t pid, int min_threads) {
    char path[80], buf[4096];
    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    FILE *file = fopen(path, "r");
    if (!file) {
        perror("fopen stat");
        return 0;
    }
    if (!fgets(buf, sizeof buf, file)) {
        perror("read stat");
        fclose(file);
        return 0;
    }
    fclose(file);
    char *fields = strrchr(buf, ')');
    if (!fields)
        return 0;
    fields += 2;
    char state = fields[0];
    char *save, *token = strtok_r(fields, " ", &save);
    int field = 3, threads = -1;
    while (token) {
        if (field == 20)
            threads = atoi(token);
        field++;
        token = strtok_r(NULL, " ", &save);
    }
    printf("state=%c threads=%d\n", state, threads);
    return state == 'Z' && threads >= min_threads;
}
int main(void) {
    setbuf(stdout, NULL);
    alarm(10);
    int fail = 0, status;
    pid_t pid = fork();
    if (!pid)
        _exit(9);
    siginfo_t info = {0};
    waitid(P_PID, pid, &info, WEXITED | WNOWAIT);
    int ok = read_stat(pid, 1);
    printf("%s retained zombie stat\n", ok ? "PASS" : "FAIL");
    fail += !ok;
    waitpid(pid, &status, 0);
    pipe(hold);
    pid = fork();
    if (!pid) {
        pthread_t thread;
        pthread_create(&thread, NULL, worker, NULL);
        syscall(SYS_exit, 0);
        _exit(99);
    }
    usleep(100000);
    ok = read_stat(pid, 2);
    printf("%s exited leader with living worker stat\n", ok ? "PASS" : "FAIL");
    fail += !ok;
    kill(pid, SIGKILL);
    waitpid(pid, &status, 0);
    printf("SUMMARY failures=%d\n", fail);
    return fail != 0;
}
