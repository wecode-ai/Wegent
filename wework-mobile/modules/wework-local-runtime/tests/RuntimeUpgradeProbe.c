#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

int main(void) {
  if (mkdir("/root/.wework-executor", 0700) != 0 && errno != EEXIST) {
    perror("create probe state directory");
    return 1;
  }
  FILE *state = fopen("/root/.wework-executor/upgrade-probe", "wx");
  if (state != NULL) {
    if (fputs(PROBE_VERSION "\n", state) == EOF || fclose(state) != 0) {
      perror("write probe state");
      return 1;
    }
  } else if (errno != EEXIST) {
    perror("create probe state");
    return 1;
  }

  puts("{\"type\":\"event\",\"event\":\"executor.ready\","
       "\"payload\":{\"ready\":true,\"device_id\":\"mobile-local:upgrade-integration\","
       "\"protocol_version\":1,\"version\":\"" PROBE_VERSION "\"}}");
  fflush(stdout);
  char request[256];
  if (!fgets(request, sizeof(request), stdin) ||
      strcmp(request, "{\"type\":\"request\",\"id\":\"health\",\"method\":\"executor.health\",\"params\":{}}\n") != 0) {
    fputs("Unexpected health request\n", stderr);
    return 1;
  }
  puts("{\"type\":\"response\",\"id\":\"health\",\"ok\":true,\"result\":{\"status\":\"healthy\"}}");
  fflush(stdout);
  while (fgets(request, sizeof(request), stdin)) {
  }
  return 0;
}
