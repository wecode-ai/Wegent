#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static int p[2];
static void *reader(void *unused) {
    (void)unused;
    char c;
    read(p[0], &c, 1);
    return NULL;
}
static void *writer(void *unused) {
    (void)unused;
    char buf[65536];
    memset(buf, 'x', sizeof buf);
    for (;;)
        write(p[1], buf, sizeof buf);
}
static long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
int main(void) {
    setbuf(stdout, NULL);
    alarm(10);
    int failed = 0;
    for (int writing = 0; writing < 2; writing++) {
        long start = now_ms();
        pid_t child = fork();
        if (!child) {
            pipe(p);
            pthread_t thread;
            pthread_create(&thread, NULL, writing ? writer : reader, NULL);
            usleep(50000);
            _exit(7);
        }
        int status;
        waitpid(child, &status, 0);
        long elapsed = now_ms() - start;
        int ok = WIFEXITED(status) && WEXITSTATUS(status) == 7 && elapsed < 500;
        printf("%s blocked pipe %s exit=%d ms=%ld\n", ok ? "PASS" : "FAIL",
               writing ? "write" : "read", WEXITSTATUS(status), elapsed);
        failed += !ok;
    }
    return failed != 0;
}
