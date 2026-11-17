#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "fs/fd.h"
#include "fs/real.h"
#include "fs/path.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include "../../ios/RuntimeStorage.h"

static void write_file(const char *path) {
    struct fd *fd = generic_open(path, O_WRONLY_ | O_CREAT_ | O_EXCL_, 0600);
    assert(!IS_ERR(fd));
    assert(fd->ops->write(fd, "retained", 8) == 8);
    assert(fd_close(fd) == 0);
}

static bool exists(const char *path) {
    struct statbuf stat;
    return generic_statat(AT_PWD, path, &stat, false) == 0;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    assert(mount_root(&fakefs, argv[1]) == 0);
    assert(become_first_process() == 0);
    const char *home = "/root/.wework-codex";
    assert(ww_runtime_clean_catalogs() == 0);
    assert(generic_mkdirat(AT_PWD, home, 0700) == 0);
    const char *catalog = "/root/.wework-codex/wework-model-catalog-12345678-1234-4321-8123-123456789abc.json";
    const char *link = "/root/.wework-codex/wework-model-catalog-12345678-1234-4321-9123-123456789abc.json";
    const char *directory = "/root/.wework-codex/wework-model-catalog-12345678-1234-4321-a123-123456789abc.json";
    const char *custom = "/root/.wework-codex/wework-model-catalog-custom.json";
    const char *non_uuid = "/root/.wework-codex/wework-model-catalog-12345678-1234-1321-8123-123456789abc.json";
    const char *auth = "/root/.wework-codex/auth.json";
    const char *session = "/root/.wework-codex/session.jsonl";
    write_file(catalog); write_file(custom); write_file(non_uuid); write_file(auth); write_file(session);
    assert(generic_symlinkat(auth, AT_PWD, link) == 0);
    assert(generic_mkdirat(AT_PWD, directory, 0700) == 0);
    ish_host_task_enter();
    assert(ww_runtime_clean_catalogs() == _EBUSY);
    assert(exists(catalog));
    ish_host_task_leave();
    assert(ww_runtime_clean_catalogs() == 0);
    assert(!exists(catalog));
    assert(exists(link) && exists(directory) && exists(custom) && exists(non_uuid));
    assert(exists(auth) && exists(session));
    assert(ww_runtime_clean_catalogs() == 0);
    assert(generic_renameat(AT_PWD, home, AT_PWD, "/root/kept") == 0);
    assert(generic_symlinkat("/root/kept", AT_PWD, home) == 0);
    assert(ww_runtime_clean_catalogs() < 0);
    assert(exists(auth));
    puts("PASS native catalog cleanup: idle-only, guest metadata, exact ownership, symlink and user-data preservation");
    return 0;
}
