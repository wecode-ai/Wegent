#ifndef WW_RUNTIME_H
#define WW_RUNTIME_H
#include <stddef.h>

struct ww_process;
int ww_runtime_available(void);
int ww_runtime_prepare(const char *archive, const char *root);
int ww_runtime_start(const char *data, const char *device, struct ww_process **out);
int ww_runtime_input(struct ww_process *process);
int ww_runtime_output(struct ww_process *process);
int ww_runtime_error(struct ww_process *process);
int ww_runtime_wait(struct ww_process *process, int *status);
int ww_runtime_stop(void);
int ww_runtime_import(const char *source, const char *destination);
int ww_runtime_refresh_dns(void);
void ww_runtime_release(struct ww_process *process);

#endif
