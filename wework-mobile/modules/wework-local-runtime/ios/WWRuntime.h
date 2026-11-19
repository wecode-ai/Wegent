#ifndef WW_RUNTIME_H
#define WW_RUNTIME_H
#include <stddef.h>

struct ww_process;
struct ww_transport_diagnostics {
    unsigned long long accept_calls, accept_failures;
    unsigned long long listeners_restored, listener_failures;
    int listener_host_error;
    int accept_host_error, accepting_pid;
    int input_bytes, output_bytes;
};
struct ww_transport_diagnostics ww_runtime_transport_diagnostics(struct ww_process *process);
int ww_runtime_available(void);
void ww_runtime_set_diagnostics_enabled(int enabled);
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
