#include "RuntimeStorage.h"
#ifdef WWR_EMBEDDED_ISH
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "fs/fd.h"
#include "kernel/calls.h"
#include "kernel/task.h"

// ProcessCatalog owns only canonical UUID-v4 names. User catalogs are not caches.
static bool generated_catalog(const char *name) {
    const char *prefix = "wework-model-catalog-";
    size_t length = strlen(prefix);
    if (strlen(name) != length + 36 + 5 || strncmp(name, prefix, length) != 0 ||
            strcmp(name + length + 36, ".json") != 0) return false;
    const char *uuid = name + length;
    for (int i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (uuid[i] != '-') return false;
        } else if (!((uuid[i] >= '0' && uuid[i] <= '9') ||
                     (uuid[i] >= 'a' && uuid[i] <= 'f'))) return false;
    }
    return uuid[14] == '4' && strchr("89ab", uuid[19]) != NULL;
}

int ww_runtime_clean_catalogs(void) {
    if (ish_host_task_count() != 0) return _EBUSY;
    struct fd *directory = generic_open("/root/.wework-codex",
            O_RDONLY_ | O_DIRECTORY_ | O_NOFOLLOW_, 0);
    if (IS_ERR(directory)) return PTR_ERR(directory) == _ENOENT ? 0 : PTR_ERR(directory);
    int result;
    struct dir_entry entry;
    while ((result = directory->ops->readdir(directory, &entry)) > 0) {
        if (!generated_catalog(entry.name)) continue;
        struct statbuf stat;
        result = generic_statat(directory, entry.name, &stat, false);
        if (result < 0) break;
        if ((stat.mode & S_IFMT) != S_IFREG) continue;
        // Guest unlink updates fakefs inode metadata as well as the host file.
        result = generic_unlinkat(directory, entry.name);
        if (result < 0) break;
    }
    int closed = fd_close(directory);
    return result < 0 ? result : closed;
}

static int copy_executor(int source, struct fd *target) {
    char buffer[64 * 1024];
    for (;;) {
        ssize_t count = read(source, buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return -errno;
        if (count == 0) return target->ops->fsync(target);
        for (ssize_t offset = 0; offset < count;) {
            ssize_t written = target->ops->write(target, buffer + offset, count - offset);
            if (written <= 0) return written < 0 ? (int)written : _EIO;
            offset += written;
        }
    }
}

// Keep all user files and fakefs metadata in place. Only the app-owned executable
// is replaced, after every guest thread has exited, through guest filesystem APIs.
int ww_runtime_replace_executor_file(const char *source) {
    if (ish_host_task_count() != 0) return _EBUSY;
    int input = open(source, O_RDONLY | O_NOFOLLOW);
    if (input < 0) return -errno;
    struct stat source_stat;
    if (fstat(input, &source_stat) < 0) { int err = -errno; close(input); return err; }
    if (!S_ISREG(source_stat.st_mode)) { close(input); return _EINVAL; }
    struct fd *opt = generic_open("/opt", O_RDONLY_ | O_DIRECTORY_ | O_NOFOLLOW_, 0);
    if (IS_ERR(opt)) { close(input); return PTR_ERR(opt); }
    struct statbuf stat;
    int result = generic_statat(opt, "wegent-executor", &stat, false);
    if (result == 0 && (stat.mode & S_IFMT) != S_IFREG) result = _EINVAL;
    const char *temporary = ".wegent-executor-update";
    if (result == 0) {
        int existing = generic_statat(opt, temporary, &stat, false);
        if (existing == 0) {
            result = (stat.mode & S_IFMT) == S_IFREG
                ? generic_unlinkat(opt, temporary) : _EINVAL;
        } else if (existing != _ENOENT) result = existing;
    }
    if (result == 0) {
        struct fd *target = generic_openat(opt, temporary,
                O_WRONLY_ | O_CREAT_ | O_EXCL_ | O_NOFOLLOW_, 0755);
        if (IS_ERR(target)) result = PTR_ERR(target);
        else {
            result = copy_executor(input, target);
            int closed = fd_close(target);
            if (result == 0) result = closed;
            if (result == 0) result = generic_renameat(opt, temporary, opt, "wegent-executor");
            if (result < 0) generic_unlinkat(opt, temporary);
        }
    }
    close(input);
    int closed = fd_close(opt);
    return result == 0 ? closed : result;
}
#endif
