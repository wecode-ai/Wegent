#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "kernel/calls.h"

extern void ish_set_host_logging(bool enabled);
extern void ish_printk(const char *, ...);

int main(void) {
    int channels[2];
    assert(pipe(channels) == 0);
    int saved_stderr = dup(2);
    int saved_console = dup(666);
    assert(saved_stderr >= 0);
    assert(dup2(channels[1], 2) == 2);
    assert(dup2(channels[1], 666) == 666);
    close(channels[1]);
    int before = sys_syslog(9, 0, 0);
    ish_set_host_logging(false);
    ish_printk("private-disabled-checkpoint\n");
    int after = sys_syslog(9, 0, 0);
    assert(after > before);
    ish_set_host_logging(true);
    ish_printk("enabled-checkpoint\n");
    ish_set_host_logging(false);
    ish_printk("private-disabled-again\n");
    fflush(stderr);
    assert(dup2(saved_stderr, 2) == 2);
    close(saved_stderr);
    if (saved_console >= 0) {
        assert(dup2(saved_console, 666) == 666);
        close(saved_console);
    } else close(666);
    char output[512] = {0};
    int count = (int)read(channels[0], output, sizeof(output) - 1);
    close(channels[0]);
    assert(count > 0);
    assert(strstr(output, "enabled-checkpoint") != NULL);
    assert(strstr(output, "private-disabled") == NULL);
    puts("PASS native diagnostic toggle preserves the kernel ring without disabled host output");
    return 0;
}
