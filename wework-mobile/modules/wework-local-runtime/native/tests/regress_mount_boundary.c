#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures;

static void check(const char *name, int passed) {
    printf("%s %s\n", passed ? "PASS" : "FAIL", name);
    failures += !passed;
}

int main(void) {
    const char *target = "/tmp/wework-mount-boundary";
    if (mkdir(target, 0700) != 0 && errno != EEXIST)
        return 2;

    const struct {
        const char *type;
        unsigned long flags;
        const char *name;
    } attempts[] = {
        {"real", 0, "guest cannot mount host filesystem"},
        {"real", MS_RDONLY, "read-only host mounts also require host ownership"},
        {"proc", 0, "guest cannot add shared proc mounts"},
        {"tmpfs", 0, "guest cannot retain tmpfs data across environment switches"},
        {"devpts", 0, "guest cannot replace shared device mounts"},
    };
    for (unsigned i = 0; i < sizeof(attempts) / sizeof(attempts[0]); i++) {
        errno = 0;
        int result = mount("/", target, attempts[i].type, attempts[i].flags, "");
        check(attempts[i].name, result == -1 && errno == EPERM);
    }
    const char *protected_mounts[] = {"/proc", "/dev/pts", "/"};
    for (unsigned i = 0; i < sizeof(protected_mounts) / sizeof(protected_mounts[0]); i++) {
        errno = 0;
        int result = umount2(protected_mounts[i], 0);
        check(protected_mounts[i], result == -1 && errno == EPERM);
    }

    int fd = open("/proc/self/stat", O_RDONLY);
    char buffer[128];
    check("host-created proc mount remains usable", fd >= 0 && read(fd, buffer, sizeof(buffer)) > 0);
    if (fd >= 0)
        close(fd);

    const char *path = "/tmp/wework-mount-boundary-file";
    const char value[] = "guest-files-still-work";
    fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    int ordinary_io = fd >= 0 && write(fd, value, sizeof(value)) == sizeof(value) &&
        lseek(fd, 0, SEEK_SET) == 0 && read(fd, buffer, sizeof(value)) == sizeof(value) &&
        memcmp(buffer, value, sizeof(value)) == 0;
    check("ordinary guest file access remains usable", ordinary_io);
    if (fd >= 0)
        close(fd);
    unlink(path);
    rmdir(target);
    return failures ? 1 : 0;
}
