#include "RuntimeStorage.h"
#ifdef WWR_EMBEDDED_ISH
#include <string.h>
#include <sys/stat.h>
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
#endif
