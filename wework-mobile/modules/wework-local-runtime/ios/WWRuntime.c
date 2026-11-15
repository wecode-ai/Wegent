#include "WWRuntime.h"
#include <errno.h>
#include <stdlib.h>
#ifdef WWR_EMBEDDED_ISH
#include <fcntl.h>
#include <pthread.h>
#include <netdb.h>
#include <resolv.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include "fs/devices.h"
#include "fs/fd.h"
#include "fs/path.h"
#include "fs/real.h"
#include "tools/fakefs.h"

enum { WAIT_ALL = 0, WAIT_PID = 1, WAIT_NOHANG = 1, WAIT_EXITED = 4, WAIT_KEEP = 1 << 24 };
extern int do_wait(int, pid_t_, struct siginfo_ *, struct rusage_ *, int);
extern int wework_ish_memory_start(void);
extern void ish_host_task_enter(void);
extern void ish_host_task_leave(void);
extern unsigned ish_host_task_count(void);

struct ww_process {
    struct task *task;
    pthread_t thread;
    int pid;
    int input, output, error;
    int launch_error;
    int wait_error, status;
    atomic_bool thread_done;
    bool finished;
};

struct command {
    int (*run)(void *);
    void *argument;
    int result;
    bool done;
    struct command *next;
};

static pthread_mutex_t host_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t host_changed = PTHREAD_COND_INITIALIZER;
static pthread_once_t owner_once = PTHREAD_ONCE_INIT;
static int owner_error;
static struct task *init_task;
static struct command *commands;
static struct ww_process *active;
static char *mounted_root;
static bool root_mounted, proc_mounted, devpts_mounted, construction_failed;
static int refresh_dns(void *unused);

static struct timespec deadline_ms(int milliseconds) {
    struct timespec value;
    clock_gettime(CLOCK_REALTIME, &value);
    value.tv_nsec += (long)milliseconds * 1000000;
    value.tv_sec += value.tv_nsec / 1000000000;
    value.tv_nsec %= 1000000000;
    return value;
}

static void reap_active(void) {
    if (active == NULL || active->finished || !atomic_load(&active->thread_done)) return;
    struct siginfo_ info = {};
    int err = do_wait(WAIT_PID, active->pid, &info, NULL, WAIT_EXITED | WAIT_KEEP | WAIT_NOHANG);
    if (err == 0 && info.child.pid == 0) return;
    int joined = pthread_join(active->thread, NULL);
    if (err == 0 && joined == 0)
        err = do_wait(WAIT_PID, active->pid, &info, NULL, WAIT_EXITED);
    pthread_mutex_lock(&host_lock);
    active->wait_error = err != 0 ? err : -joined;
    active->status = info.child.status;
    active->finished = true;
    pthread_cond_broadcast(&host_changed);
    pthread_mutex_unlock(&host_lock);
}

static void *owner_main(void *unused) {
    (void)unused;
    for (;;) {
        pthread_mutex_lock(&host_lock);
        if (commands == NULL) {
            struct timespec until = deadline_ms(100);
            pthread_cond_timedwait(&host_changed, &host_lock, &until);
        }
        struct command *command = commands;
        if (command != NULL) commands = command->next;
        pthread_mutex_unlock(&host_lock);
        if (command != NULL) {
            int result = command->run(command->argument);
            pthread_mutex_lock(&host_lock);
            command->result = result;
            command->done = true;
            pthread_cond_broadcast(&host_changed);
            pthread_mutex_unlock(&host_lock);
        }
        if (init_task != NULL) reap_active();
    }
}

static void start_owner(void) {
    pthread_t owner;
    owner_error = pthread_create(&owner, NULL, owner_main, NULL);
    if (owner_error == 0) pthread_detach(owner);
}

static int execute(int (*run)(void *), void *argument) {
    pthread_once(&owner_once, start_owner);
    if (owner_error != 0) return -owner_error;
    struct command command = {.run = run, .argument = argument};
    pthread_mutex_lock(&host_lock);
    struct command **tail = &commands;
    while (*tail != NULL) tail = &(*tail)->next;
    *tail = &command;
    pthread_cond_broadcast(&host_changed);
    while (!command.done) pthread_cond_wait(&host_changed, &host_lock);
    pthread_mutex_unlock(&host_lock);
    return command.result;
}

static int directory(const char *path) {
    int result = generic_mkdirat(AT_PWD, path, 0700);
    return result == _EEXIST ? 0 : result;
}

static int system_mounts(void) {
    const char *paths[] = {"/proc", "/dev", "/dev/pts", "/root", "/root/imports"};
    for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
        int result = directory(paths[i]);
        if (result < 0) return result;
    }
    struct { const char *path; int major; int minor; } devices[] = {
        {"/dev/null", MEM_MAJOR, DEV_NULL_MINOR}, {"/dev/zero", MEM_MAJOR, DEV_ZERO_MINOR},
        {"/dev/full", MEM_MAJOR, DEV_FULL_MINOR}, {"/dev/random", MEM_MAJOR, DEV_RANDOM_MINOR},
        {"/dev/urandom", MEM_MAJOR, DEV_URANDOM_MINOR},
        {"/dev/tty", TTY_ALTERNATE_MAJOR, DEV_TTY_MINOR},
        {"/dev/ptmx", TTY_ALTERNATE_MAJOR, DEV_PTMX_MINOR},
    };
    for (size_t i = 0; i < sizeof(devices) / sizeof(devices[0]); i++) {
        int result = generic_mknodat(AT_PWD, devices[i].path, S_IFCHR | 0666,
                dev_make(devices[i].major, devices[i].minor));
        if (result < 0 && result != _EEXIST) return result;
    }
    int result = do_mount(&procfs, "proc", "/proc", "", 0);
    if (result < 0) return result;
    proc_mounted = true;
    result = do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
    if (result == 0) devpts_mounted = true;
    return result;
}

static int select_root(const char *data) {
    if (active != NULL || ish_host_task_count() != 0) return -EBUSY;
    if (construction_failed) return -ECANCELED;
    if (mounted_root != NULL && strcmp(mounted_root, data) == 0) return 0;
    if (init_task == NULL) {
        int result = wework_ish_memory_start();
        if (result < 0) return result;
        result = mount_root(&fakefs, data);
        if (result < 0) return result;
        root_mounted = true;
        result = become_first_process();
        if (result < 0) {
            do_umount(""); root_mounted = false; construction_failed = true;
            return result;
        }
        init_task = current;
        current->thread = pthread_self();
    } else {
        /* No prior-account guest thread can remain at the mount boundary. */
        free(mounted_root); mounted_root = NULL;
        if (current->fs->pwd != NULL) fd_close(current->fs->pwd);
        current->fs->pwd = NULL;
        if (current->fs->root != NULL) fd_close(current->fs->root);
        current->fs->root = NULL;
        const char *points[] = {"/dev/pts", "/proc", ""};
        bool *mounted[] = {&devpts_mounted, &proc_mounted, &root_mounted};
        for (size_t i = 0; i < sizeof(points) / sizeof(points[0]); i++) {
            if (!*mounted[i]) continue;
            int result = do_umount(points[i]);
            if (result < 0) return result;
            *mounted[i] = false;
        }
        int result = mount_root(&fakefs, data);
        if (result < 0) return result;
        root_mounted = true;
        struct fd *root = generic_open("/", O_RDONLY_, 0);
        if (IS_ERR(root)) return PTR_ERR(root);
        current->fs->root = root;
        current->fs->pwd = fd_retain(root);
    }
    int result = system_mounts();
    if (result < 0) return result;
    char *name = strdup(data);
    if (name == NULL) return -ENOMEM;
    free(mounted_root);
    mounted_root = name;
    return 0;
}

static void child_finished(void *opaque) {
    struct ww_process *process = opaque;
    ish_host_task_leave();
    atomic_store(&process->thread_done, true);
    pthread_cond_broadcast(&host_changed);
}

static void *child_main(void *opaque) {
    struct ww_process *process = opaque;
    current = process->task;
    current->thread = pthread_self();
    pthread_cleanup_push(child_finished, process);
    if (process->launch_error < 0) do_exit(127 << 8);
    task_run_current();
    pthread_cleanup_pop(1);
    return NULL;
}

static int install_pipe(int host_fd, int guest_fd) {
    struct fd *fd = adhoc_fd_create(&realfs_fdops);
    if (fd == NULL) return _ENOMEM;
    fd->real_fd = host_fd;
    fd->stat.mode = S_IFIFO | 0600;
    fd->flags = guest_fd == 0 ? O_RDONLY_ : O_WRONLY_;
    current->files->files[guest_fd] = fd;
    return 0;
}

struct start_arguments { const char *data; const char *device; struct ww_process **out; };
static int launch(void *opaque) {
    struct start_arguments *args = opaque;
    int err = select_root(args->data);
    if (err < 0) return err;
    err = refresh_dns(NULL);
    if (err < 0) return err;
    struct ww_process *process = calloc(1, sizeof(*process));
    if (process == NULL) return -ENOMEM;
    int pipes[3][2];
    for (int i = 0; i < 3; i++) {
        if (pipe(pipes[i]) == 0) continue;
        err = -errno;
        for (int j = 0; j < i; j++) { close(pipes[j][0]); close(pipes[j][1]); }
        free(process);
        return err;
    }
    err = become_new_init_child();
    if (err < 0) {
        for (int i = 0; i < 3; i++) { close(pipes[i][0]); close(pipes[i][1]); }
        free(process);
        return err;
    }
    process->task = current;
    process->pid = current->pid;
    process->input = pipes[0][1]; process->output = pipes[1][0]; process->error = pipes[2][0];
    int child_fds[] = {pipes[0][0], pipes[1][1], pipes[2][1]};
    for (int i = 0; i < 3; i++) {
        if (err == 0) err = install_pipe(child_fds[i], i);
        if (err < 0) close(child_fds[i]);
    }
    char env[2048];
    static const char base_env[] =
        "HOME=/root\0PATH=/opt/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\0"
        "LANG=C.UTF-8\0TERM=xterm-256color\0WEGENT_EXECUTOR_HOME=/root/.wework-executor\0"
        "WEGENT_CODEX_HOME=/root/.wework-codex\0CODEX_HOME=/root/.wework-codex\0"
        "WEGENT_EXECUTOR_DISABLE_FILE_LOG=true\0"
        "CODEX_BINARY_PATH=/opt/codex/bin/codex\0";
    memcpy(env, base_env, sizeof(base_env) - 1);
    int count = snprintf(env + sizeof(base_env) - 1, sizeof(env) - sizeof(base_env),
            "WEGENT_APP_IPC_DEVICE_ID=%s", args->device);
    if (count < 0 || (size_t)count >= sizeof(env) - sizeof(base_env) - 1) err = -EINVAL;
    else env[sizeof(base_env) + count] = 0;
    if (err == 0) err = do_execve("/opt/wegent-executor", 1, "/opt/wegent-executor\0", env);
    process->launch_error = err;
    current = init_task;
    ish_host_task_enter();
    int thread_error = pthread_create(&process->thread, NULL, child_main, process);
    if (thread_error != 0) {
        ish_host_task_leave();
        task_discard_unstarted(process->task);
        close(process->input); close(process->output); close(process->error);
        free(process);
        return -thread_error;
    }
    process->task->thread = process->thread;
    active = process;
    *args->out = process;
    return err;
}

static int signal_children(void *opaque) {
    int signal_number = *(int *)opaque;
    if (init_task == NULL) return 0;
    lock(&pids_lock);
    for (unsigned pid = 2; pid <= MAX_PID; pid++) {
        struct task *task = pid_get_task(pid);
        if (task != NULL && !task->zombie)
            send_signal(task, signal_number, (struct siginfo_) {.code = SI_KERNEL_});
    }
    unlock(&pids_lock);
    return 0;
}

static int finish_stop(void *unused) {
    (void)unused;
    if (ish_host_task_count() != 0 || (active != NULL && !active->finished)) return -EBUSY;
    if (init_task != NULL) {
        for (;;) {
            struct siginfo_ info = {};
            int result = do_wait(WAIT_ALL, 0, &info, NULL, WAIT_EXITED | WAIT_NOHANG);
            if (result == _ECHILD) break;
            if (result < 0) return result;
            if (info.child.pid == 0) return -EBUSY;
        }
    }
    active = NULL;
    return 0;
}

struct import_arguments { const char *source; const char *destination; };
static int refresh_dns(void *unused) {
    (void)unused;
    if (init_task == NULL || mounted_root == NULL) return -ENODEV;
    struct __res_state resolver = {};
    if (res_ninit(&resolver) != 0) return -EIO;
    union res_sockaddr_union servers[MAXNS];
    int count = res_getservers(&resolver, servers, MAXNS);
    char configuration[8192];
    size_t length = 0;
    int result = 0;
    for (int i = 0; i < count && i < MAXNS; i++) {
        if (servers[i].sin.sin_len == 0) continue;
        char address[NI_MAXHOST];
        if (getnameinfo((struct sockaddr *)&servers[i].sin, servers[i].sin.sin_len,
                address, sizeof(address), NULL, 0, NI_NUMERICHOST) != 0) {
            result = -EIO; break;
        }
        int size = snprintf(configuration + length, sizeof(configuration) - length,
                "nameserver %s\n", address);
        if (size < 0 || (size_t)size >= sizeof(configuration) - length) { result = -EOVERFLOW; break; }
        length += (size_t)size;
    }
    res_nclose(&resolver);
    if (result < 0) return result;
    // An empty resolver configuration truthfully represents an offline device;
    // it must never retain DNS addresses from the machine that built the image.
    const char *temporary = "/etc/resolv.conf.wework-tmp";
    struct fd *fd = generic_open(temporary, O_CREAT_ | O_TRUNC_ | O_WRONLY_, 0644);
    if (IS_ERR(fd)) return PTR_ERR(fd);
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = fd->ops->write(fd, configuration + offset, length - offset);
        if (written <= 0) { result = written < 0 ? (int)written : -EIO; break; }
        offset += (size_t)written;
    }
    int closed = fd_close(fd);
    if (result == 0) result = closed;
    if (result == 0) result = generic_renameat(AT_PWD, temporary, AT_PWD, "/etc/resolv.conf");
    if (result < 0) generic_unlinkat(AT_PWD, temporary);
    return result;
}

static int import_file(void *opaque) {
    struct import_arguments *args = opaque;
    if (init_task == NULL || mounted_root == NULL) return -ENODEV;
    int source = open(args->source, O_RDONLY);
    if (source < 0) return -errno;
    struct fd *target = generic_open(args->destination, O_CREAT_ | O_EXCL_ | O_WRONLY_, 0600);
    if (IS_ERR(target)) { close(source); return PTR_ERR(target); }
    char buffer[65536];
    int result = 0;
    for (;;) {
        ssize_t count = read(source, buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { result = -errno; break; }
        if (count == 0) break;
        ssize_t offset = 0;
        while (offset < count) {
            ssize_t size = target->ops->write(target, buffer + offset, count - offset);
            if (size <= 0) { result = size < 0 ? (int)size : -EIO; break; }
            offset += size;
        }
        if (result < 0) break;
    }
    close(source);
    int closed = fd_close(target);
    if (result == 0) result = closed;
    if (result < 0) generic_unlinkat(AT_PWD, args->destination);
    return result;
}

int ww_runtime_available(void) { return 1; }
int ww_runtime_prepare(const char *archive, const char *root) {
    struct fakefsify_error error = {};
    if (fakefs_import(archive, root, &error, (struct progress){})) return 0;
    free((void *)error.message);
    return -EIO;
}
int ww_runtime_start(const char *data, const char *device, struct ww_process **out) {
    struct start_arguments args = {data, device, out};
    return execute(launch, &args);
}
int ww_runtime_input(struct ww_process *process) { return process->input; }
int ww_runtime_output(struct ww_process *process) { return process->output; }
int ww_runtime_error(struct ww_process *process) { return process->error; }
int ww_runtime_wait(struct ww_process *process, int *status) {
    pthread_mutex_lock(&host_lock);
    while (!process->finished) pthread_cond_wait(&host_changed, &host_lock);
    *status = process->status;
    int result = process->wait_error;
    pthread_mutex_unlock(&host_lock);
    return result;
}
int ww_runtime_stop(void) {
    int signal_number = SIGTERM_;
    execute(signal_children, &signal_number);
    for (int attempt = 0; attempt < 100; attempt++) {
        int result = execute(finish_stop, NULL);
        if (result != -EBUSY) return result;
        if (attempt == 30) { signal_number = SIGKILL_; execute(signal_children, &signal_number); }
        struct timespec delay = {.tv_nsec = 100000000};
        nanosleep(&delay, NULL);
    }
    return -ETIMEDOUT;
}
int ww_runtime_import(const char *source, const char *destination) {
    struct import_arguments args = {source, destination};
    return execute(import_file, &args);
}
void ww_runtime_release(struct ww_process *process) { free(process); }
int ww_runtime_refresh_dns(void) { return execute(refresh_dns, NULL); }
#else
int ww_runtime_available(void) { return 0; }
int ww_runtime_prepare(const char *archive, const char *root) { return -ENOTSUP; }
int ww_runtime_start(const char *data, const char *device, struct ww_process **out) { return -ENOTSUP; }
int ww_runtime_input(struct ww_process *process) { return -1; }
int ww_runtime_output(struct ww_process *process) { return -1; }
int ww_runtime_error(struct ww_process *process) { return -1; }
int ww_runtime_wait(struct ww_process *process, int *status) { return -ENOTSUP; }
int ww_runtime_stop(void) { return -ENOTSUP; }
int ww_runtime_import(const char *source, const char *destination) { return -ENOTSUP; }
void ww_runtime_release(struct ww_process *process) { free(process); }
int ww_runtime_refresh_dns(void) { return -ENOTSUP; }
#endif
