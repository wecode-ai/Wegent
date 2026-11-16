// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#include <assert.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static char *root;

static void *write_thread(void *unused) {
    (void)unused;
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/writer.lock", root);
    int writer = open(path, O_CREAT | O_RDWR, 0600);
    assert(writer >= 0 && flock(writer, LOCK_EX) == 0);
    snprintf(path, sizeof(path), "%s/writer-ready.tmp", root);
    FILE *ready = fopen(path, "w");
    assert(ready != NULL);
    fprintf(ready, "%d", getpid());
    fclose(ready);
    char published[PATH_MAX];
    snprintf(published, sizeof(published), "%s/writer-ready", root);
    assert(rename(path, published) == 0);
    for (;;) pause();
    return NULL;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    root = strdup(argv[1]);
    pthread_t writer;
    assert(pthread_create(&writer, NULL, write_thread, NULL) == 0);
    // The thread-group leader exits while the worker owns the shared file table.
    pthread_exit(NULL);
}
