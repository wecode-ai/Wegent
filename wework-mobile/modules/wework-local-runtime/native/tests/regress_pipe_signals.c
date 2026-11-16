#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t handled;
static void on_signal(int signal) {
    (void)signal;
    handled++;
}

int main(void) {
    setbuf(stdout, NULL);
    alarm(10);
    int failures = 0;
    for (int restart = 0; restart < 2; restart++) {
        for (int large = 0; large < 2; large++) {
            int pipe_fds[2];
            if (pipe(pipe_fds) < 0)
                return 2;
            struct sigaction action = {.sa_handler = on_signal};
            action.sa_flags = restart ? SA_RESTART : 0;
            sigemptyset(&action.sa_mask);
            sigaction(SIGUSR1, &action, NULL);
            handled = 0;
            pid_t parent = getpid();
            pid_t child = fork();
            if (child < 0)
                return 2;
            if (child == 0) {
                usleep(50000);
                kill(parent, SIGUSR1);
                usleep(50000);
                if (write(pipe_fds[1], "x", 1) != 1)
                    _exit(2);
                _exit(0);
            }
            char buffer[8192];
            ssize_t result = read(pipe_fds[0], buffer, large ? sizeof(buffer) : 1);
            int error = errno;
            int status;
            waitpid(child, &status, 0);
            int valid = handled == 1 && WIFEXITED(status) && WEXITSTATUS(status) == 0;
            valid &= restart ? result == 1 && buffer[0] == 'x' : result == -1 && error == EINTR;
            printf("%s pipe read size=%d SA_RESTART=%d result=%zd errno=%d signals=%d\n",
                   valid ? "PASS" : "FAIL", large ? 8192 : 1, restart, result, error, handled);
            failures += !valid;
            close(pipe_fds[0]);
            close(pipe_fds[1]);
        }
    }
    return failures != 0;
}
